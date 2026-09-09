import type { SenderAuthPolicy } from '../../core/senderAuth.ts'
import type { SiteConfig } from '../../core/types.ts'

/**
 * Worker environment bindings.
 *
 * Everything here is a Wrangler secret or var — no site config or
 * credential is ever committed. See `config.example.json` /
 * `.dev.vars.example`.
 */
export interface Env {
  /** GitHub App installation token, or a PAT for local testing. */
  GITHUB_TOKEN: string
  /** Shared secret required in the email subject as `[token]`. */
  EMAIL_SUBJECT_TOKEN: string
  /** Comma-separated allowlist of envelope sender addresses. */
  ALLOWED_SENDERS: string
  /** Bearer token for the HTTPS path. */
  API_TOKEN: string
  /** e.g. "TeamNickHart" */
  GITHUB_OWNER: string
  /** e.g. "your-blog" */
  GITHUB_REPO: string
  /** Branch to target, e.g. "main" */
  GITHUB_BASE_BRANCH: string
  /** e.g. "data/blog" */
  CONTENT_PATH: string
  /** e.g. ".mdx" */
  CONTENT_EXTENSION: string
  /**
   * Set to "false" only if the mail platform does not stamp SPF/DKIM
   * results. Deliberate downgrade — see senderAuth.ts.
   */
  REQUIRE_AUTH_RESULTS?: string
  /**
   * Set to "false" to keep email signatures in the post body. On by
   * default; only the standard `"-- "` delimiter is recognised.
   */
  STRIP_SIGNATURE?: string
}

/** Fail loudly at request time if a required binding is missing. */
function required(env: Env, key: keyof Env): string {
  const value = env[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required binding: ${key}`)
  }
  return value
}

export function siteConfigFromEnv(env: Env): SiteConfig {
  return {
    owner: required(env, 'GITHUB_OWNER'),
    repo: required(env, 'GITHUB_REPO'),
    baseBranch: required(env, 'GITHUB_BASE_BRANCH'),
    contentPath: required(env, 'CONTENT_PATH'),
    extension: required(env, 'CONTENT_EXTENSION'),
  }
}

export function senderAuthPolicyFromEnv(env: Env): SenderAuthPolicy {
  return {
    allowedSenders: required(env, 'ALLOWED_SENDERS')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean),
    subjectToken: required(env, 'EMAIL_SUBJECT_TOKEN'),
    requireAuthResults: env.REQUIRE_AUTH_RESULTS !== 'false',
  }
}
