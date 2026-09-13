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
   * Who may post to this site, and as whom: an envelope address mapped to the
   * basename of a file in the site's `data/authors` directory.
   *
   * **This is the single source of truth for the sender allowlist.** An address
   * not listed here cannot post. The allowlist used to be a separate
   * `<SITE>_ALLOWED_SENDERS` secret holding the same addresses, which meant the
   * same information in two places — and the two drifted, producing an
   * allowlist that matched nothing while the author map looked correct.
   *
   * **Each name must match a real file.** Frontmatter naming an author that
   * does not exist breaks the site build, so a typo here is a broken deploy
   * rather than a cosmetic mistake. `validateSites` checks the shape and
   * `pnpm check:authors` checks the files against each repo.
   *
   * Use `default` as the name for a sender who should post under the site's own
   * default author rather than a personal one.
   */
  authorsBySender: Record<string, string>
}

/** The shape of `sites.jsonc`. */
export interface SitesFile {
  sites: SiteDefinition[]
}

/** Per-site secrets, resolved from the environment. */
export interface SiteSecrets {
  allowedSenders: string[]
  apiToken?: string
  /**
   * GitHub credential used to write to this site's repo. Falls back to the
   * global `GITHUB_TOKEN` when the site does not define its own.
   */
  githubToken: string
  /**
   * Subject-line secret accepted for this site. Falls back to the global
   * `EMAIL_SUBJECT_TOKEN`; empty when neither is set, which means the token
   * fallback simply does not exist for this site.
   */
  subjectToken: string
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

    validateAuthorMap(site)
    validateAssets(site)
  }

  return sites
}

/**
 * Check a site's `assets` block, if it declares one.
 *
 * A site without one refuses attachments outright, which is a valid choice —
 * but a half-filled block would commit files somewhere the site does not serve,
 * so both fields are required together.
 */
function validateAssets(site: SiteDefinition): void {
  const assets = site.assets
  if (assets === undefined) return

  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) {
    throw new ConfigError(`site ${site.key} has an assets block that is not an object`)
  }
  for (const field of ['directory', 'urlPrefix'] as const) {
    if (typeof assets[field] !== 'string' || assets[field].trim() === '') {
      throw new ConfigError(`site ${site.key} assets is missing \`${field}\``)
    }
  }
  if (assets.directory.startsWith('/') || assets.directory.includes('..')) {
    throw new ConfigError(
      `site ${site.key} assets.directory must be a repo-relative path with no "..": ${assets.directory}`,
    )
  }
  if (!assets.urlPrefix.startsWith('/')) {
    throw new ConfigError(
      `site ${site.key} assets.urlPrefix must start with "/" — it is a site-absolute URL: ${assets.urlPrefix}`,
    )
  }
  for (const field of ['directory', 'urlPrefix'] as const) {
    if (assets[field].endsWith('/')) {
      throw new ConfigError(`site ${site.key} assets.${field} must not end with "/"`)
    }
  }
}

/**
 * Check an `authorsBySender` map for the mistakes that would break a build.
 *
 * The author name becomes a filename in the site's `data/authors` directory,
 * so a value with a path separator, an extension, or stray whitespace produces
 * frontmatter pointing at a file that cannot exist. Whether the file is
 * actually there can only be answered by the target repo, so this checks
 * everything short of that.
 */
function validateAuthorMap(site: SiteDefinition): void {
  const map = site.authorsBySender

  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new ConfigError(`site ${site.key} has an authorsBySender that is not an object`)
  }
  // It is the allowlist, so an empty one means nobody can post. That is a
  // misconfiguration worth catching at build time rather than on the first
  // rejected message.
  if (Object.keys(map).length === 0) {
    throw new ConfigError(
      `site ${site.key} has an empty authorsBySender — it is the sender allowlist, so at least one address is required`,
    )
  }

  const seen = new Set<string>()
  for (const [address, author] of Object.entries(map)) {
    const normalized = address.trim().toLowerCase()
    if (!normalized.includes('@')) {
      throw new ConfigError(
        `site ${site.key} maps an author to something that is not an address: ${address}`,
      )
    }
    // Two entries differing only in case would make resolution depend on
    // object key order.
    if (seen.has(normalized)) {
      throw new ConfigError(`site ${site.key} maps ${normalized} to an author more than once`)
    }
    seen.add(normalized)

    if (typeof author !== 'string' || author.trim() === '') {
      throw new ConfigError(`site ${site.key} maps ${normalized} to an empty author`)
    }
    // A name is a bare basename: no directory, no extension.
    if (!/^[A-Za-z0-9._-]+$/.test(author) || author.includes('..')) {
      throw new ConfigError(
        `site ${site.key} maps ${normalized} to an invalid author name "${author}" — use the basename of a file in data/authors, with no path or extension`,
      )
    }
    if (/\.(mdx?|md)$/i.test(author)) {
      throw new ConfigError(
        `site ${site.key} maps ${normalized} to "${author}" — drop the extension, the site adds it`,
      )
    }
  }
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

  // Derived from the author map rather than read from a secret: the two held
  // the same addresses, and drifted. `validateSites` has already checked that
  // every key is address-shaped and that the map is non-empty.
  const allowedSenders = allowedSendersFor(site)

  const apiToken = env[`${prefix}_API_TOKEN`]?.trim()

  // Per-site value if set, else the global one. A fallback rather than a
  // requirement so that adding per-site tokens is incremental: an existing
  // deployment with only the global secrets keeps working, and sites can be
  // moved across one at a time.
  const githubToken =
    env[`${prefix}_GITHUB_TOKEN`]?.trim() || env.GITHUB_TOKEN?.trim() || ''
  if (!githubToken) {
    throw new ConfigError(
      `site ${site.key} has no GitHub token: set ${prefix}_GITHUB_TOKEN or GITHUB_TOKEN`,
    )
  }

  const subjectToken =
    env[`${prefix}_EMAIL_SUBJECT_TOKEN`]?.trim() || env.EMAIL_SUBJECT_TOKEN?.trim() || ''

  return {
    allowedSenders,
    githubToken,
    subjectToken,
    ...(apiToken ? { apiToken } : {}),
  }
}

/**
 * The addresses permitted to post to a site: the keys of its author map.
 *
 * Lowercased, because an envelope sender is compared case-insensitively.
 */
export function allowedSendersFor(site: SiteDefinition): string[] {
  return Object.keys(site.authorsBySender).map((address) => address.trim().toLowerCase())
}

/**
 * Author name to the one address that should be notified about their posts.
 *
 * First entry wins where a name has several addresses: the others may still
 * post, but only one gets told about it. Deliberately not every address — one
 * notification per sending address means several copies of the same email.
 */
export function notifyAddressByAuthor(site: SiteDefinition): Record<string, string> {
  const byAuthor: Record<string, string> = {}
  for (const [address, author] of Object.entries(site.authorsBySender)) {
    byAuthor[author] ??= address.trim().toLowerCase()
  }
  return byAuthor
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
