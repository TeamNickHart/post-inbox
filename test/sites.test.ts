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
  it('derives the env var prefix from the key', () => {
    expect(secretPrefix('mysite')).toBe('MYSITE')
    expect(secretPrefix('my-site')).toBe('MY_SITE')
  })

  it('reads the allowlist and token for a site', () => {
    const secrets = secretsForSite(site(), {
      MYSITE_ALLOWED_SENDERS: 'A@example.com, b@example.com',
      MYSITE_API_TOKEN: 'tok',
    })
    expect(secrets.allowedSenders).toEqual(['a@example.com', 'b@example.com'])
    expect(secrets.apiToken).toBe('tok')
  })

  it('treats a missing allowlist as a misconfiguration, not allow-everyone', () => {
    expect(() => secretsForSite(site(), {})).toThrow(/MYSITE_ALLOWED_SENDERS/)
    expect(() => secretsForSite(site(), { MYSITE_ALLOWED_SENDERS: ' , ' })).toThrow(ConfigError)
  })

  it('allows a site with no api token, for email-only posting', () => {
    const secrets = secretsForSite(site(), { MYSITE_ALLOWED_SENDERS: 'a@example.com' })
    expect(secrets.apiToken).toBeUndefined()
  })

  it('does not read another site\'s secrets', () => {
    expect(() =>
      secretsForSite(site({ key: 'other' }), { MYSITE_ALLOWED_SENDERS: 'a@example.com' }),
    ).toThrow(/OTHER_ALLOWED_SENDERS/)
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
