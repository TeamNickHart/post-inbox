import type { SiteConfig } from './types.ts'

/**
 * Multi-site configuration.
 *
 * Configuration splits along secrecy, not convenience:
 *
 *  - **Committed**, in `sites.jsonc`: which inbound address maps to which
 *    repo, branch and content path. None of it is sensitive, and keeping it
 *    in git means a change to it is reviewable and diffable.
 *
 *  - **Secret**, as individual per-site environment variables named from each
 *    site's `key` (`NICKHART_ALLOWED_SENDERS`, `NICKHART_API_TOKEN`): the
 *    sender allowlist and bearer token. Small values, set one at a time.
 *
 * The alternative — one JSON blob in a single secret — was rejected: it takes
 * no comments, does not diff, cannot be read back once set, and one typo
 * breaks every site at once.
 */

/** A site as declared in `sites.jsonc`. */
export interface SiteDefinition extends SiteConfig {
  /**
   * Short identifier, also the prefix for this site's secrets. Uppercased
   * and with hyphens replaced by underscores: key `nickhart` reads
   * `NICKHART_ALLOWED_SENDERS` and `NICKHART_API_TOKEN`.
   */
  key: string
  /**
   * Inbound email addresses routed to this site, lowercased. One address per
   * site is the intended setup: the address the mail was sent *to* is what
   * selects the site, which Cloudflare Email Routing gives for free.
   */
  inboundAddresses: string[]
  /**
   * Per-sender author mapping: an envelope address to the basename of a file
   * in the site's `data/authors` directory.
   *
   * Not yet populated anywhere — the field exists so that mapping a family
   * member's address to their own author page is a config change rather than
   * a schema change. An address absent from this map posts under the site's
   * default author.
   */
  authorsBySender?: Record<string, string>
}

/** The shape of `sites.jsonc`. */
export interface SitesFile {
  sites: SiteDefinition[]
}

/** Per-site secrets, resolved from the environment. */
export interface SiteSecrets {
  allowedSenders: string[]
  apiToken?: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Validate a parsed sites file, failing loudly on anything ambiguous.
 *
 * A misconfiguration here decides where posts get committed, so it is checked
 * eagerly rather than discovered when an email arrives.
 */
export function validateSites(file: unknown): SiteDefinition[] {
  if (typeof file !== 'object' || file === null || !Array.isArray((file as SitesFile).sites)) {
    throw new ConfigError('sites config must be an object with a `sites` array')
  }

  const sites = (file as SitesFile).sites
  if (sites.length === 0) throw new ConfigError('sites config declares no sites')

  const seenKeys = new Set<string>()
  const seenAddresses = new Set<string>()

  for (const site of sites) {
    for (const field of ['key', 'owner', 'repo', 'baseBranch', 'contentPath', 'extension'] as const) {
      if (typeof site[field] !== 'string' || site[field].trim() === '') {
        throw new ConfigError(`site ${site.key ?? '(unnamed)'} is missing \`${field}\``)
      }
    }

    if (!/^[a-z][a-z0-9-]*$/.test(site.key)) {
      throw new ConfigError(
        `site key "${site.key}" must be lowercase letters, digits and hyphens — it becomes an environment variable prefix`,
      )
    }
    if (seenKeys.has(site.key)) throw new ConfigError(`duplicate site key: ${site.key}`)
    seenKeys.add(site.key)

    if (!Array.isArray(site.inboundAddresses) || site.inboundAddresses.length === 0) {
      throw new ConfigError(`site ${site.key} declares no inboundAddresses`)
    }
    for (const address of site.inboundAddresses) {
      const normalized = address.trim().toLowerCase()
      if (!normalized.includes('@')) {
        throw new ConfigError(`site ${site.key} has an invalid inbound address: ${address}`)
      }
      // Two sites claiming one address would make routing arbitrary.
      if (seenAddresses.has(normalized)) {
        throw new ConfigError(`inbound address ${normalized} is claimed by more than one site`)
      }
      seenAddresses.add(normalized)
    }
  }

  return sites
}

/** Find the site an inbound message belongs to, by the address it was sent to. */
export function siteForAddress(
  sites: SiteDefinition[],
  address: string,
): SiteDefinition | undefined {
  const normalized = address.trim().toLowerCase()
  return sites.find((site) =>
    site.inboundAddresses.some((candidate) => candidate.trim().toLowerCase() === normalized),
  )
}

/** Find a site by its key, for the HTTPS path. */
export function siteForKey(sites: SiteDefinition[], key: string): SiteDefinition | undefined {
  const normalized = key.trim().toLowerCase()
  return sites.find((site) => site.key === normalized)
}

/** The environment-variable prefix for a site's secrets. */
export function secretPrefix(key: string): string {
  return key.toUpperCase().replace(/-/g, '_')
}

/**
 * Read a site's secrets out of an environment record.
 *
 * `allowedSenders` is required — an empty allowlist is a misconfiguration
 * rather than "allow everyone" — while `apiToken` is optional, since a site
 * may be email-only.
 */
export function secretsForSite(
  site: SiteDefinition,
  env: Record<string, string | undefined>,
): SiteSecrets {
  const prefix = secretPrefix(site.key)

  // Split on commas or whitespace. Tolerating both matters because the value
  // is hand-entered: a space-separated list stored as one string would contain
  // an `@`, look superficially valid, and match no sender at all — a silent
  // failure where every message is rejected.
  const raw = env[`${prefix}_ALLOWED_SENDERS`]
  const allowedSenders = (raw ?? '')
    .split(/[,\s]+/)
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)

  if (allowedSenders.length === 0) {
    throw new ConfigError(
      `site ${site.key} has no allowed senders: set ${prefix}_ALLOWED_SENDERS`,
    )
  }

  // An entry with no `@` can never match an envelope sender, so it is a
  // misconfiguration worth naming rather than a rule that silently never fires.
  const malformed = allowedSenders.filter((address) => !address.includes('@'))
  if (malformed.length > 0) {
    throw new ConfigError(
      `site ${site.key} has malformed entries in ${prefix}_ALLOWED_SENDERS: ${malformed.join(', ')}`,
    )
  }

  const apiToken = env[`${prefix}_API_TOKEN`]?.trim()
  return { allowedSenders, ...(apiToken ? { apiToken } : {}) }
}

/**
 * Resolve the author file for a sender, if the site maps one.
 *
 * Returns undefined when unmapped, which leaves the frontmatter without an
 * `authors` field so the site falls back to its own default author.
 */
export function authorFileForSender(
  site: SiteDefinition,
  sender: string,
): string | undefined {
  const normalized = sender.trim().toLowerCase()
  const mapped = site.authorsBySender?.[normalized]
  return mapped?.trim() || undefined
}
