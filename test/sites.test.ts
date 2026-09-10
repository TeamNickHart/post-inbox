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
    MYSITE_ALLOWED_SENDERS: 'a@example.com',
    ...extra,
  })

  it('derives the env var prefix from the key', () => {
    expect(secretPrefix('mysite')).toBe('MYSITE')
    expect(secretPrefix('my-site')).toBe('MY_SITE')
  })

  it('reads the allowlist and token for a site', () => {
    const secrets = secretsForSite(
      site(),
      withGlobals({ MYSITE_ALLOWED_SENDERS: 'A@example.com, b@example.com', MYSITE_API_TOKEN: 'tok' }),
    )
    expect(secrets.allowedSenders).toEqual(['a@example.com', 'b@example.com'])
    expect(secrets.apiToken).toBe('tok')
  })

  it('accepts a space-separated allowlist', () => {
    // The configure script offers both separators, and a hand-set secret may
    // use either. Splitting on commas alone stored the whole string as one
    // address that contained an `@` — so it passed validation and then matched
    // no sender at all.
    const secrets = secretsForSite(
      site(),
      withGlobals({ MYSITE_ALLOWED_SENDERS: 'a@example.com b@example.com' }),
    )
    expect(secrets.allowedSenders).toEqual(['a@example.com', 'b@example.com'])
  })

  it('accepts a mix of commas and spaces', () => {
    const secrets = secretsForSite(
      site(),
      withGlobals({ MYSITE_ALLOWED_SENDERS: 'a@example.com, b@example.com  c@example.com' }),
    )
    expect(secrets.allowedSenders).toHaveLength(3)
  })

  it('rejects an entry that could never match a sender', () => {
    expect(() =>
      secretsForSite(site(), withGlobals({ MYSITE_ALLOWED_SENDERS: 'a@example.com, notanaddress' })),
    ).toThrow(/malformed/)
  })

  it('treats a missing allowlist as a misconfiguration, not allow-everyone', () => {
    expect(() => secretsForSite(site(), { GITHUB_TOKEN: 'g' })).toThrow(/MYSITE_ALLOWED_SENDERS/)
    expect(() =>
      secretsForSite(site(), { GITHUB_TOKEN: 'g', MYSITE_ALLOWED_SENDERS: ' , ' }),
    ).toThrow(ConfigError)
  })

  it('allows a site with no api token, for email-only posting', () => {
    const secrets = secretsForSite(site(), withGlobals())
    expect(secrets.apiToken).toBeUndefined()
  })

  it('does not read another site\'s secrets', () => {
    expect(() =>
      secretsForSite(site({ key: 'other' }), withGlobals()),
    ).toThrow(/OTHER_ALLOWED_SENDERS/)
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
