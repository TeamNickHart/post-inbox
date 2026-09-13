import {
  ConfigError,
  secretsForSite,
  siteForAddress,
  siteForKey,
  validateSites,
  type SiteDefinition,
  type SiteSecrets,
} from '../../core/sites.ts'
import sitesFile from '../../generated/sites.json' with { type: 'json' }

/**
 * Worker environment bindings.
 *
 * Site *definitions* live in `sites.jsonc` — gitignored, because this repo is
 * public and that file names the addresses that accept mail and the repos
 * written to. `scripts/build-sites.mjs` compiles it into the bundle.
 *
 * Site *secrets* are individual per-site variables named from each site's key
 * (`NICKHART_ALLOWED_SENDERS`, `NICKHART_API_TOKEN`) rather than one JSON
 * blob: each is small, individually settable, and never printed.
 */
export interface Env {
  /**
   * Default GitHub credential, used by any site that does not set its own
   * `<SITE>_GITHUB_TOKEN`. Must reach every repo it is the default for.
   */
  GITHUB_TOKEN?: string
  /**
   * Default subject-line secret, used by any site that does not set its own
   * `<SITE>_EMAIL_SUBJECT_TOKEN`. Only consulted when SPF/DKIM verdicts
   * cannot vouch for a message.
   */
  EMAIL_SUBJECT_TOKEN?: string
  /**
   * Set to "false" only if the mail platform does not stamp SPF/DKIM
   * results. Deliberate downgrade — see senderAuth.ts.
   */
  REQUIRE_AUTH_RESULTS?: string
  /** Set to "false" to keep email signatures in the post body. */
  STRIP_SIGNATURE?: string
  /** Set to "true" to commit posts with `draft: true`. */
  POST_AS_DRAFT?: string
  /** Per-site secrets, e.g. `NICKHART_ALLOWED_SENDERS`. */
  [key: string]: string | undefined
}

/**
 * Bindings, kept out of `Env` rather than declared on it.
 *
 * `Env`'s index signature exists so per-site secrets can be looked up by a
 * computed name, and it must admit every member's type. Declaring a binding on
 * `Env` therefore means widening that signature to
 * `string | ImagesBinding | undefined`, which then makes `Env` unassignable to
 * the `Record<string, string | undefined>` that `secretsForSite` takes — so the
 * widening propagates outward until something gives. Intersecting instead keeps
 * `Env` exactly as it was and confines the binding to the code that uses it.
 */
export type EnvWithBindings = Env & {
  /**
   * Cloudflare Images, for converting HEIC. Optional on purpose: absent means
   * such an attachment is refused with advice, which is a supported state
   * rather than a broken one, and making it optional is what proves that at
   * compile time.
   */
  IMAGES?: ImagesBinding
}

/**
 * The configured sites, validated once at module load.
 *
 * `scripts/build-sites.mjs` validates before bundling; doing it again here
 * costs nothing and means a hand-edited bundle cannot slip through.
 */
export const SITES: SiteDefinition[] = validateSites(sitesFile)

export { ConfigError }

/** Resolve the site an inbound email was addressed to, with its secrets. */
export function siteForInboundAddress(
  address: string,
  env: Env,
): { site: SiteDefinition; secrets: SiteSecrets } {
  const site = siteForAddress(SITES, address)
  if (!site) throw new ConfigError(`no site configured for inbound address ${address}`)
  return { site, secrets: secretsForSite(site, env) }
}

/** Resolve a site by key for the HTTPS path, with its secrets. */
export function siteForRequestKey(
  key: string,
  env: Env,
): { site: SiteDefinition; secrets: SiteSecrets } {
  const site = siteForKey(SITES, key)
  if (!site) throw new ConfigError(`no site configured with key ${key}`)
  return { site, secrets: secretsForSite(site, env) }
}

