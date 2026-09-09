/**
 * Sender authentication for the email path.
 *
 * A `From:` header is trivially forgeable, so an allowlist alone is not
 * a real control. Two independent checks are applied:
 *
 *  1. The SPF/DKIM/DMARC verdicts the receiving MX stamped on the
 *     message, parsed out of `Authentication-Results` (or the ARC
 *     variant). This is the check the design doc calls for.
 *
 *  2. A shared secret the sender includes in the subject line. This does
 *     not depend on the mail platform stamping anything, which matters
 *     because Cloudflare Email Routing does not currently populate those
 *     verdicts reliably (cloudflare/workerd#6740). Without this second
 *     factor, an unstamped message would leave the allowlist as the only
 *     barrier — i.e. no barrier at all.
 *
 * Both must pass. Verdicts that are absent are treated as failures, never
 * as "assume fine": this fails closed.
 */

export type AuthVerdict = 'pass' | 'fail' | 'none'

export interface AuthenticationResults {
  spf: AuthVerdict
  dkim: AuthVerdict
  dmarc: AuthVerdict
}

export interface SenderAuthPolicy {
  /** Lowercased envelope addresses permitted to create posts. */
  allowedSenders: string[]
  /** Shared secret required in the subject line. */
  subjectToken: string
  /**
   * Set false only to work around a mail platform that does not stamp
   * authentication results. Leaves the subject token as the sole factor,
   * so it is a deliberate, logged downgrade — not a default.
   */
  requireAuthResults?: boolean
}

export interface SenderAuthInput {
  /** Envelope MAIL FROM, as reported by the mail platform. */
  envelopeFrom: string
  /** Raw `Authentication-Results` header, if present. */
  authenticationResults?: string | null
  /** Raw `ARC-Authentication-Results` header, if present. */
  arcAuthenticationResults?: string | null
  subject: string
}

export type SenderAuthResult =
  | { ok: true; sender: string; auth: AuthenticationResults }
  | { ok: false; reason: string }

/**
 * Pull the spf/dkim/dmarc verdicts out of an RFC 8601
 * `Authentication-Results` header value.
 */
export function parseAuthenticationResults(header: string | null | undefined): AuthenticationResults {
  const results: AuthenticationResults = { spf: 'none', dkim: 'none', dmarc: 'none' }
  if (!header) return results

  for (const method of ['spf', 'dkim', 'dmarc'] as const) {
    // e.g. "spf=pass (google.com: domain of ...)" — capture just the verdict.
    const match = new RegExp(`\\b${method}=([a-z]+)`, 'i').exec(header)
    const verdict = match?.[1]?.toLowerCase()
    if (verdict === 'pass') {
      results[method] = 'pass'
    } else if (verdict !== undefined && verdict !== 'none') {
      // softfail, permerror, temperror, neutral, policy — none of these
      // are a pass, and we deliberately do not distinguish them.
      results[method] = 'fail'
    }
  }
  return results
}

/**
 * Strip the shared-secret token from a subject line.
 *
 * Accepted anywhere in the subject as `[token]`, so the remaining text is
 * usable as the post title.
 */
export function extractSubjectToken(subject: string): { token: string | null; title: string } {
  const match = /\[([^\]]+)\]/.exec(subject)
  if (!match) return { token: null, title: subject.trim() }

  const title = (subject.slice(0, match.index) + subject.slice(match.index + match[0].length))
    .replace(/\s+/g, ' ')
    .trim()
  return { token: match[1]!.trim(), title }
}

/** Constant-time-ish string comparison, to avoid leaking the token by timing. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Decide whether a message is allowed to create a post.
 *
 * Returns a reason string on rejection, suitable for logging but not for
 * echoing back to the sender — telling an attacker which check failed is
 * free information.
 */
export function authenticateSender(
  input: SenderAuthInput,
  policy: SenderAuthPolicy,
): SenderAuthResult {
  const sender = input.envelopeFrom.trim().toLowerCase()

  const allowed = policy.allowedSenders.map((address) => address.trim().toLowerCase())
  if (!allowed.includes(sender)) {
    return { ok: false, reason: `sender not allowlisted: ${sender}` }
  }

  const { token } = extractSubjectToken(input.subject)
  if (!policy.subjectToken) {
    return { ok: false, reason: 'no subject token configured' }
  }
  if (!token || !secretsMatch(token, policy.subjectToken)) {
    return { ok: false, reason: 'missing or invalid subject token' }
  }

  // Prefer the header the receiving MX stamped; fall back to the ARC
  // variant, which is where Cloudflare Email Routing records results.
  const auth = parseAuthenticationResults(
    input.authenticationResults ?? input.arcAuthenticationResults,
  )

  if (policy.requireAuthResults !== false) {
    if (auth.spf !== 'pass' && auth.dkim !== 'pass') {
      return {
        ok: false,
        reason: `no passing SPF or DKIM verdict (spf=${auth.spf}, dkim=${auth.dkim}, dmarc=${auth.dmarc})`,
      }
    }
    if (auth.dmarc === 'fail') {
      return { ok: false, reason: 'DMARC failed' }
    }
  }

  return { ok: true, sender, auth }
}
