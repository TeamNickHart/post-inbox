import { authenticateSender, extractSubjectToken, type SenderAuthPolicy } from './senderAuth.ts'
import { stripSignature } from './signature.ts'
import type { DraftPostRequest } from './types.ts'

/**
 * The decision an ingestion adapter has to make about an inbound message,
 * separated from the platform APIs that deliver it.
 *
 * This exists so the accept/reject logic is testable without a live Worker.
 * The adapter's remaining job is mechanical: pull these fields off the
 * platform's message object, and act on the verdict.
 */
export interface InboundEmail {
  /** Envelope sender, as reported by the mail platform. */
  envelopeFrom: string
  subject: string
  /** Raw `Authentication-Results` header, if the platform stamped one. */
  authenticationResults?: string | null
  /** Raw `ARC-Authentication-Results` header, if present. */
  arcAuthenticationResults?: string | null
  /** Plaintext body. Absent for HTML-only mail, which we do not convert. */
  text?: string | null
  /** The message date, if the platform parsed one. */
  date?: Date | null
}

export interface EmailToPostOptions {
  policy: SenderAuthPolicy
  /** Strip an RFC 3676 signature block from the body. Defaults to true. */
  stripSignature?: boolean
  /** Commit the post with `draft: true`. Defaults to false. */
  draft?: boolean
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date
}

export type EmailToPostResult =
  | {
      ok: true
      request: DraftPostRequest
      /**
       * True when the subject token, not SPF/DKIM, is what admitted this
       * message. Worth logging: the strong controls were unavailable.
       */
      viaSubjectToken: boolean
    }
  | { ok: false; reason: string }

/**
 * Decide whether an inbound email may become a post, and if so, what post.
 *
 * Rejection reasons are for logging only — the sender gets a generic
 * message, because telling an attacker which check failed is free
 * information.
 */
export function emailToPost(
  email: InboundEmail,
  options: EmailToPostOptions,
): EmailToPostResult {
  const auth = authenticateSender(
    {
      envelopeFrom: email.envelopeFrom,
      authenticationResults: email.authenticationResults,
      arcAuthenticationResults: email.arcAuthenticationResults,
      subject: email.subject,
    },
    options.policy,
  )
  if (!auth.ok) return { ok: false, reason: auth.reason }

  const { title } = extractSubjectToken(email.subject)
  if (!title) return { ok: false, reason: 'empty subject after removing token' }

  const raw = email.text?.trim()
  if (!raw) return { ok: false, reason: 'no plaintext body' }

  const body = (options.stripSignature === false ? raw : stripSignature(raw)).trim()
  if (!body) return { ok: false, reason: 'body was empty after stripping the signature' }

  return {
    ok: true,
    viaSubjectToken: auth.viaSubjectToken,
    request: {
      title,
      body,
      date: email.date ?? (options.now ?? (() => new Date()))(),
      author: auth.sender,
      draft: options.draft === true,
    },
  }
}
