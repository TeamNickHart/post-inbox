import {
  attachmentsToCommit,
  placeAttachments,
  planAttachments,
  type InboundAttachment,
  type Placement,
  type RejectedAttachment,
} from './attachments.ts'
import { parseHeaders } from './headers.ts'
import { slugify } from './markdown.ts'
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
  /** Attachments, as the platform parsed them. */
  attachments?: InboundAttachment[]
}

export interface EmailToPostOptions {
  policy: SenderAuthPolicy
  /**
   * Where this site commits attachments. Omit to refuse them — an attachment
   * then becomes a rejection note rather than silently vanishing.
   */
  assets?: { directory: string; urlPrefix: string }
  /** Strip an RFC 3676 signature block from the body. Defaults to true. */
  stripSignature?: boolean
  /** Commit the post with `draft: true`. Defaults to false. */
  draft?: boolean
  /** Injectable for tests; defaults to the current time. */
  now?: () => Date
}

/**
 * Why a message was turned away.
 *
 * The distinction is a security one, not a tidiness one. An `auth` failure
 * must be reported to the sender generically: naming the check that failed
 * tells someone probing the system whether an address is allowlisted, or
 * whether their guessed token was the wrong length. A `content` failure
 * happens only *after* the sender is authenticated, so there is nobody left to
 * withhold information from — and a sender who wrote an unusable message needs
 * to be told what was wrong with it.
 */
export type RejectionKind = 'auth' | 'content'

export type EmailToPostResult =
  | {
      ok: true
      request: DraftPostRequest
      /**
       * True when the subject token, not SPF/DKIM, is what admitted this
       * message. Worth logging: the strong controls were unavailable.
       */
      viaSubjectToken: boolean
      /**
       * Attachments that could not be committed, with the reason. Worth
       * surfacing in the pull request: the post was created, but not
       * everything the sender attached made it.
       */
      rejectedAttachments: RejectedAttachment[]
      /** Which rule placed each image. For logging; see `Placement`. */
      placements: Placement[]
    }
  | {
      ok: false
      kind: RejectionKind
      /** For our logs. Never sent to the sender verbatim when kind is 'auth'. */
      reason: string
      /**
       * Safe to send to an authenticated sender, when there is something
       * actionable to say. Absent for `auth` failures.
       */
      senderMessage?: string
    }

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
  // Everything below this line has passed authentication, so failures from
  // here on may explain themselves to the sender.
  if (!auth.ok) return { ok: false, kind: 'auth', reason: auth.reason }

  const { title } = extractSubjectToken(email.subject)
  if (!title) {
    return {
      ok: false,
      kind: 'content',
      reason: 'empty subject after removing token',
      senderMessage: 'the subject line became empty once the token was removed, so the post has no title',
    }
  }

  const raw = email.text?.trim()
  if (!raw) {
    return {
      ok: false,
      kind: 'content',
      reason: 'no plaintext body',
      // The common cause by far: a client composing HTML with no text part.
      senderMessage:
        'the message had no plain-text body — HTML-only mail is not supported, so send the post as plain text',
    }
  }

  const stripped = (options.stripSignature === false ? raw : stripSignature(raw)).trim()
  if (!stripped) {
    return {
      ok: false,
      kind: 'content',
      reason: 'body was empty after stripping the signature',
      senderMessage: 'the body was empty once the signature was removed',
    }
  }

  // Metadata the subject line cannot carry: `Tags:` and `Summary:` lines at
  // the top of the body.
  const { tags, summary, body } = parseHeaders(stripped)
  if (!body) {
    return {
      ok: false,
      kind: 'content',
      reason: 'body was empty after removing the header block',
      senderMessage: 'the message contained only a Tags/Summary block and no post body',
    }
  }

  // Attachments are named from the post's slug, so the slug has to be settled
  // before they can be planned.
  const attachments = email.attachments ?? []
  let finalBody = body
  let rejectedAttachments: RejectedAttachment[] = []
  let placements: Placement[] = []
  let extraFiles: DraftPostRequest['extraFiles']

  if (attachments.length > 0) {
    if (!options.assets) {
      rejectedAttachments = attachments.map((attachment) => ({
        filename: attachment.filename,
        reason: 'this site is not configured to accept attachments',
      }))
    } else {
      const plan = planAttachments(attachments, slugify(title), options.assets)
      rejectedAttachments = plan.rejected
      if (plan.accepted.length > 0) {
        const placed = placeAttachments(body, plan.accepted)
        finalBody = placed.body
        placements = placed.placements
        extraFiles = attachmentsToCommit(plan.accepted)
      }
    }
  }

  return {
    ok: true,
    viaSubjectToken: auth.viaSubjectToken,
    rejectedAttachments,
    placements,
    request: {
      title,
      body: finalBody,
      ...(tags ? { tags } : {}),
      ...(summary ? { summary } : {}),
      ...(extraFiles ? { extraFiles } : {}),
      ...(rejectedAttachments.length > 0 ? { rejectedAttachments } : {}),
      date: email.date ?? (options.now ?? (() => new Date()))(),
      author: auth.sender,
      draft: options.draft === true,
    },
  }
}
