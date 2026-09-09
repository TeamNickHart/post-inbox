/**
 * Sender authentication for the email path.
 *
 * A `From:` header is trivially forgeable, so an allowlist alone is not a
 * real control. Two independent factors are available:
 *
 *  1. **The strong pair**: an allowlisted envelope sender, plus the
 *     SPF/DKIM/DMARC verdicts the receiving MX stamped on the message. A
 *     forged sender fails these, because an attacker cannot produce the
 *     victim domain's DKIM signature.
 *
 *  2. **A shared secret in the subject line**, as a fallback for when the
 *     strong pair is unavailable. It does not depend on the mail platform
 *     stamping anything, which matters because Cloudflare Email Routing has
 *     been reported to deliver messages with no verdicts at all
 *     (cloudflare/workerd#6740).
 *
 * The token is required only when the strong pair did not carry the
 * message: no allowlist configured, verdict checking disabled, or verdicts
 * that did not actually pass. When SPF/DKIM passed *and* the sender is on a
 * configured allowlist, the token is redundant and is not demanded — but if
 * one is supplied it must still be correct, so a stale token in a subject
 * line fails loudly rather than being silently ignored.
 *
 * Verdicts that are absent are treated as failures, never as "assume fine":
 * this fails closed.
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
  /**
   * Shared secret accepted in the subject line. Required only when the
   * SPF/DKIM + allowlist pair cannot carry the message on its own; see the
   * module comment. May be empty, in which case that fallback does not
   * exist and a message lacking passing verdicts is simply rejected.
   */
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
  | {
      ok: true
      sender: string
      auth: AuthenticationResults
      /**
       * True when the subject token was what let this message through,
       * rather than passing SPF/DKIM. Worth logging: it means the strong
       * controls were unavailable.
       */
      viaSubjectToken: boolean
    }
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

  const allowed = policy.allowedSenders
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean)

  // An empty allowlist is a misconfiguration, not "allow everyone".
  if (allowed.length === 0) {
    return { ok: false, reason: 'no allowed senders configured' }
  }
  if (!allowed.includes(sender)) {
    return { ok: false, reason: `sender not allowlisted: ${sender}` }
  }

  // Prefer the header the receiving MX stamped; fall back to the ARC
  // variant, which is where Cloudflare Email Routing records results.
  const auth = parseAuthenticationResults(
    input.authenticationResults ?? input.arcAuthenticationResults,
  )

  // The strong pair: a passing SPF or DKIM verdict, no DMARC failure, and a
  // sender that is on the allowlist (already established above). DKIM alone
  // is enough because forwarding routinely breaks SPF while leaving the
  // signature intact.
  const verdictsChecked = policy.requireAuthResults !== false
  const verdictsPassed =
    (auth.spf === 'pass' || auth.dkim === 'pass') && auth.dmarc !== 'fail'
  const strongPairHolds = verdictsChecked && verdictsPassed

  const { token } = extractSubjectToken(input.subject)

  // A supplied token must be correct even when it was not required — a
  // stale or wrong token should fail loudly, not be quietly ignored.
  if (token !== null) {
    if (!policy.subjectToken || !secretsMatch(token, policy.subjectToken)) {
      return { ok: false, reason: 'invalid subject token' }
    }
    return { ok: true, sender, auth, viaSubjectToken: !strongPairHolds }
  }

  if (strongPairHolds) {
    return { ok: true, sender, auth, viaSubjectToken: false }
  }

  // The strong pair did not carry this message, so the token was the
  // fallback — and it is absent.
  if (!policy.subjectToken) {
    return {
      ok: false,
      reason: `no subject token configured and ${whyVerdictsFailed(auth, verdictsChecked)}`,
    }
  }
  return { ok: false, reason: `subject token required: ${whyVerdictsFailed(auth, verdictsChecked)}` }
}

/** Explain, for the log, why the SPF/DKIM pair did not carry a message. */
function whyVerdictsFailed(auth: AuthenticationResults, verdictsChecked: boolean): string {
  if (!verdictsChecked) return 'verdict checking is disabled'

  const detail = `spf=${auth.spf}, dkim=${auth.dkim}, dmarc=${auth.dmarc}`
  // Report DMARC separately: a DMARC failure alongside a passing SPF or DKIM
  // is the signature of a forgery that got past one check but failed
  // alignment, which reads very differently in a log from "nothing passed".
  if (auth.dmarc === 'fail' && (auth.spf === 'pass' || auth.dkim === 'pass')) {
    return `DMARC failed (${detail})`
  }
  return `no passing SPF or DKIM verdict (${detail})`
}
