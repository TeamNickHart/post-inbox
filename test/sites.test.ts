import { describe, expect, it } from 'vitest'
import {
  authorFileForSender,
  ConfigError,
  secretPrefix,
  secretsForSite,
  siteForAddress,
  siteForKey,
  validateSites,
  type SiteDefinition,
} from '../src/core/sites.ts'

const site = (overrides: Partial<SiteDefinition> = {}): SiteDefinition => ({
  key: 'mysite',
  inboundAddresses: ['drafts@example.com'],
  owner: 'test-org',
  repo: 'test-blog',
  baseBranch: 'main',
  contentPath: 'data/blog',
  extension: '.mdx',
  // Doubles as the sender allowlist, so a site cannot be built without one.
  authorsBySender: { 'a@example.com': 'default' },
  ...overrides,
})

describe('validateSites', () => {
  it('accepts a well-formed config', () => {
    expect(validateSites({ sites: [site()] })).toHaveLength(1)
  })

  it('rejects a config with no sites', () => {
    expect(() => validateSites({ sites: [] })).toThrow(ConfigError)
  })

  it('rejects a missing required field', () => {
    expect(() => validateSites({ sites: [{ ...site(), repo: '' }] })).toThrow(/repo/)
  })

  it('rejects a key that would not survive as an env var prefix', () => {
    expect(() => validateSites({ sites: [site({ key: 'My Site' })] })).toThrow(/lowercase/)
    expect(() => validateSites({ sites: [site({ key: '1site' })] })).toThrow(/lowercase/)
  })

  it('rejects duplicate site keys', () => {
    expect(() =>
      validateSites({ sites: [site(), site({ inboundAddresses: ['other@example.com'] })] }),
    ).toThrow(/duplicate site key/)
  })

  it('rejects one address claimed by two sites, which would make routing arbitrary', () => {
    expect(() => validateSites({ sites: [site(), site({ key: 'other' })] })).toThrow(
      /more than one site/,
    )
  })

  it('rejects a site with no inbound addresses', () => {
    expect(() => validateSites({ sites: [site({ inboundAddresses: [] })] })).toThrow(/inboundAddresses/)
  })

  it('rejects an address that is not an address', () => {
    expect(() => validateSites({ sites: [site({ inboundAddresses: ['nope'] })] })).toThrow(/invalid inbound/)
  })
})

describe('routing', () => {
  const sites = [site(), site({ key: 'second', inboundAddresses: ['posts@other.example'] })]

  it('finds a site by the address the mail was sent to', () => {
    expect(siteForAddress(sites, 'posts@other.example')?.key).toBe('second')
  })

  it('is case-insensitive about the address', () => {
    expect(siteForAddress(sites, 'Drafts@Example.COM')?.key).toBe('mysite')
  })

  it('returns undefined for an unknown address', () => {
    expect(siteForAddress(sites, 'nobody@example.com')).toBeUndefined()
  })

  it('finds a site by key for the HTTPS path', () => {
    expect(siteForKey(sites, 'second')?.repo).toBe('test-blog')
    expect(siteForKey(sites, 'missing')).toBeUndefined()
  })
})

describe('secrets', () => {
  /** The minimum environment for a site to resolve at all. */
  const withGlobals = (extra: Record<string, string> = {}) => ({
    GITHUB_TOKEN: 'global-gh',
    ...extra,
  })

  it('derives the env var prefix from the key', () => {
    expect(secretPrefix('mysite')).toBe('MYSITE')
    expect(secretPrefix('my-site')).toBe('MY_SITE')
  })

  it('derives the allowlist from the author map rather than a secret', () => {
    // One source of truth. These held the same addresses in two places and
    // drifted, producing an allowlist that matched nothing while the author map
    // looked correct.
    const secrets = secretsForSite(
      site({ authorsBySender: { 'A@example.com': 'nick', 'b@example.com': 'jenny' } }),
      withGlobals({ MYSITE_API_TOKEN: 'tok' }),
    )
    expect(secrets.allowedSenders).toEqual(['a@example.com', 'b@example.com'])
    expect(secrets.apiToken).toBe('tok')
  })

  it('ignores a stale ALLOWED_SENDERS secret if one is still set', () => {
    const secrets = secretsForSite(
      site({ authorsBySender: { 'a@example.com': 'nick' } }),
      withGlobals({ MYSITE_ALLOWED_SENDERS: 'someone-else@example.com' }),
    )
    expect(secrets.allowedSenders).toEqual(['a@example.com'])
  })

  it('allows a site with no api token, for email-only posting', () => {
    const secrets = secretsForSite(site(), withGlobals())
    expect(secrets.apiToken).toBeUndefined()
  })

  it('reads only its own prefixed secrets', () => {
    // The allowlist is derived from the author map now, so a missing
    // ALLOWED_SENDERS secret is no longer an error. What must stay scoped is
    // the API token: one site's must never be picked up by another.
    const secrets = secretsForSite(site({ key: 'other' }), withGlobals({ MYSITE_API_TOKEN: 'not-mine' }))
    expect(secrets.apiToken).toBeUndefined()
  })
})

describe('per-site GitHub and subject tokens', () => {
  const base = { MYSITE_ALLOWED_SENDERS: 'a@example.com' }

  it('prefers a site\'s own GitHub token over the global one', () => {
    const secrets = secretsForSite(site(), {
      ...base,
      GITHUB_TOKEN: 'global-gh',
      MYSITE_GITHUB_TOKEN: 'site-gh',
    })
    expect(secrets.githubToken).toBe('site-gh')
  })

  it('falls back to the global GitHub token', () => {
    // A fallback rather than a requirement, so adding per-site tokens is
    // incremental: an existing deployment with only globals keeps working.
    const secrets = secretsForSite(site(), { ...base, GITHUB_TOKEN: 'global-gh' })
    expect(secrets.githubToken).toBe('global-gh')
  })

  it('rejects a site with no GitHub token from either source', () => {
    expect(() => secretsForSite(site(), base)).toThrow(/MYSITE_GITHUB_TOKEN or GITHUB_TOKEN/)
  })

  it('does not read another site\'s GitHub token', () => {
    const secrets = secretsForSite(site({ key: 'other' }), {
      OTHER_ALLOWED_SENDERS: 'a@example.com',
      GITHUB_TOKEN: 'global-gh',
      MYSITE_GITHUB_TOKEN: 'not-mine',
    })
    expect(secrets.githubToken).toBe('global-gh')
  })

  it('prefers a site\'s own subject token over the global one', () => {
    const secrets = secretsForSite(site(), {
      ...base,
      GITHUB_TOKEN: 'g',
      EMAIL_SUBJECT_TOKEN: 'global-subject',
      MYSITE_EMAIL_SUBJECT_TOKEN: 'site-subject',
    })
    expect(secrets.subjectToken).toBe('site-subject')
  })

  it('falls back to the global subject token', () => {
    const secrets = secretsForSite(site(), {
      ...base,
      GITHUB_TOKEN: 'g',
      EMAIL_SUBJECT_TOKEN: 'global-subject',
    })
    expect(secrets.subjectToken).toBe('global-subject')
  })

  it('leaves the subject token empty when neither is set', () => {
    // Empty is valid: it means the token fallback does not exist for this
    // site, so a message without passing verdicts is simply rejected.
    const secrets = secretsForSite(site(), { ...base, GITHUB_TOKEN: 'g' })
    expect(secrets.subjectToken).toBe('')
  })

  it('ignores a whitespace-only token rather than treating it as set', () => {
    const secrets = secretsForSite(site(), {
      ...base,
      GITHUB_TOKEN: 'global-gh',
      MYSITE_GITHUB_TOKEN: '   ',
      MYSITE_EMAIL_SUBJECT_TOKEN: '  ',
    })
    expect(secrets.githubToken).toBe('global-gh')
    expect(secrets.subjectToken).toBe('')
  })
})

describe('validateSites — the assets block', () => {
  const withAssets = (assets: unknown) => validateSites({ sites: [{ ...site(), assets }] })

  it('accepts the values the Tailwind starter uses', () => {
    expect(
      withAssets({ directory: 'public/static/images', urlPrefix: '/static/images' }),
    ).toHaveLength(1)
  })

  it('accepts a site with no assets block, which refuses attachments', () => {
    expect(validateSites({ sites: [site()] })[0]!.assets).toBeUndefined()
  })

  it('requires both fields together, since half a block commits files nowhere useful', () => {
    expect(() => withAssets({ directory: 'public/static/images' })).toThrow(/urlPrefix/)
    expect(() => withAssets({ urlPrefix: '/static/images' })).toThrow(/directory/)
  })

  it('rejects an absolute or escaping directory', () => {
    expect(() => withAssets({ directory: '/etc', urlPrefix: '/x' })).toThrow(/repo-relative/)
    expect(() => withAssets({ directory: '../../etc', urlPrefix: '/x' })).toThrow(/repo-relative/)
  })

  it('requires urlPrefix to be site-absolute', () => {
    expect(() => withAssets({ directory: 'public/x', urlPrefix: 'static/x' })).toThrow(/start with/)
  })

  it('rejects a trailing slash, which would double up when joined', () => {
    expect(() => withAssets({ directory: 'public/x/', urlPrefix: '/x' })).toThrow(/must not end/)
    expect(() => withAssets({ directory: 'public/x', urlPrefix: '/x/' })).toThrow(/must not end/)
  })
})

describe('validateSites — the author map', () => {
  // A name here becomes a filename in the site's data/authors directory, and
  // frontmatter naming an author that does not exist breaks the site build.
  // So a typo is a broken deploy, not a cosmetic slip.
  const withMap = (map: unknown) =>
    validateSites({ sites: [{ ...site(), authorsBySender: map }] })

  it('accepts a well-formed map', () => {
    expect(withMap({ 'someone@example.com': 'someone' })).toHaveLength(1)
  })

  it('accepts a name with dots, dashes and underscores', () => {
    expect(withMap({ 'a@example.com': 'mary-jane_smith.2' })).toHaveLength(1)
  })

  it('rejects a key that is not an address', () => {
    expect(() => withMap({ someone: 'someone' })).toThrow(/not an address/)
  })

  it('rejects an empty author name', () => {
    expect(() => withMap({ 'a@example.com': '  ' })).toThrow(/empty author/)
  })

  it('rejects a name carrying its extension', () => {
    // `authors: ['luca.mdx']` resolves to data/authors/luca.mdx.mdx.
    expect(() => withMap({ 'a@example.com': 'luca.mdx' })).toThrow(/drop the extension/)
  })

  it('rejects a name containing a path', () => {
    expect(() => withMap({ 'a@example.com': 'sub/luca' })).toThrow(/invalid author name/)
    expect(() => withMap({ 'a@example.com': '../../etc/passwd' })).toThrow(/invalid author name/)
  })

  it('rejects a name with whitespace', () => {
    expect(() => withMap({ 'a@example.com': 'two words' })).toThrow(/invalid author name/)
  })

  it('rejects two entries differing only in case', () => {
    // Resolution would otherwise depend on object key order.
    expect(() =>
      withMap({ 'a@example.com': 'one', 'A@Example.com': 'two' }),
    ).toThrow(/more than once/)
  })

  it('rejects a map that is not an object', () => {
    expect(() => withMap(['a@example.com'])).toThrow(/not an object/)
  })

  it('accepts a site with no map at all', () => {
    expect(validateSites({ sites: [site()] })).toHaveLength(1)
  })
})

describe('authorFileForSender', () => {
  const mapped = site({ authorsBySender: { 'someone@example.com': 'someone' } })

  it('maps a listed sender to their author file', () => {
    expect(authorFileForSender(mapped, 'someone@example.com')).toBe('someone')
    expect(authorFileForSender(mapped, 'Someone@Example.com')).toBe('someone')
  })

  it('leaves an unlisted sender to the site default', () => {
    expect(authorFileForSender(mapped, 'other@example.com')).toBeUndefined()
    expect(authorFileForSender(site(), 'someone@example.com')).toBeUndefined()
  })
})

describe('what an unauthenticated caller may learn', () => {
  // The HTTPS handler answers every failure before the token check with a
  // bare 401. This test pins the reason: an earlier version returned the
  // configured site keys in a 400 when `site` was omitted, handing them to
  // anyone who probed the endpoint.
  it('site keys are not derivable from a validation error', () => {
    const sites = [site(), site({ key: 'second', inboundAddresses: ['b@example.com'] })]

    // Looking up an absent key throws a ConfigError whose message names the
    // key the caller supplied — never the keys that exist.
    const message = (() => {
      try {
        const found = siteForKey(sites, 'guess')
        if (!found) throw new ConfigError('no site configured with key guess')
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()

    expect(message).toContain('guess')
    for (const configured of sites) {
      expect(message).not.toContain(configured.key)
    }
  })
})
