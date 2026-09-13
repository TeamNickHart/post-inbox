import type { FileToCommit } from './github.ts'
import { stripImageMetadata } from './metadata.ts'

/**
 * Email attachments becoming files in the site repo.
 *
 * Scope, deliberately: this decides what may be committed and under what name.
 * It does not resize or re-encode — the site's build already does that, since
 * the Tailwind starter pipes every markdown image through `next/image`, so
 * resizing and modern-format delivery happen for free from whatever source file
 * the post points at.
 *
 * Format *conversion* is the one exception, and it happens before this function
 * sees anything: `core/imageConversion.ts` turns a HEIC into a JPEG, because
 * `next/image` cannot decode HEIC either and a committed HEIC would be a broken
 * image rather than an unoptimised one. An attachment arriving here is already
 * in a format a browser renders, or it is refused.
 */

/**
 * What may be committed, and as what.
 *
 * An allowlist rather than a denylist: an unexpected type is refused, not
 * accepted by default. Keyed by MIME type, with the extension we trust over
 * whatever the filename claims.
 */
const ALLOWED_TYPES: Record<string, { extension: string; kind: 'image' | 'document' }> = {
  'image/jpeg': { extension: '.jpg', kind: 'image' },
  'image/png': { extension: '.png', kind: 'image' },
  'image/gif': { extension: '.gif', kind: 'image' },
  'image/webp': { extension: '.webp', kind: 'image' },
  'application/pdf': { extension: '.pdf', kind: 'document' },
}

/**
 * Types refused with an explanation rather than a bare "unsupported".
 *
 * HEIC reaches here only when conversion was unavailable — the site has not
 * enabled it, or no converter was configured. When conversion was attempted and
 * failed, `convertAttachments` sets `refusalOverride` instead, because the
 * camera setting named below is then not the problem.
 *
 * Worth keeping the advice even so: it is still the fix for a site running
 * without a converter, and Gmail web and macOS Mail both convert on send
 * anyway, so a sender rarely sees any of this.
 */
const REFUSED_TYPES: Record<string, string> = {
  'image/heic':
    'HEIC images are not supported — no browser renders them. On iPhone, Settings > Camera > Formats > Most Compatible makes the camera shoot JPEG instead.',
  'image/heif':
    'HEIF images are not supported — no browser renders them. On iPhone, Settings > Camera > Formats > Most Compatible makes the camera shoot JPEG instead.',
}

/**
 * Per-attachment size cap.
 *
 * 10MB is where GitHub's blob API stays comfortable, and base64 inflates the
 * payload by a third on the way — so this is well inside the real limit rather
 * than at it. It doubles as abuse prevention.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Total across one message, so a hundred small files cannot substitute. */
export const MAX_TOTAL_BYTES = 25 * 1024 * 1024

/** An attachment as an ingestion adapter hands it over. */
export interface InboundAttachment {
  /** Filename as the sender's client supplied it. Untrusted. */
  filename: string
  /** MIME type as the client declared it. Also untrusted, but checkable. */
  mimeType: string
  bytes: Uint8Array
  /**
   * True when the part belongs to a `multipart/related` group — RFC 2387, how
   * every mail client marks an image embedded in the message body rather than
   * merely attached to it.
   *
   * Note this is *not* `Content-Disposition: inline`. A real Gmail message
   * carrying one embedded and one attached image reports `disposition:
   * "attachment"` for **both**, and only the embedded one has `related: true`.
   * Keying placement to the disposition would therefore detect nothing.
   */
  related?: boolean
  /**
   * Refusal reason to use instead of the one keyed to the MIME type.
   *
   * Set by `convertAttachments` when a conversion was attempted and failed, so
   * the message explains that rather than telling the sender to change a camera
   * setting that was not the problem. See `core/imageConversion.ts`.
   */
  refusalOverride?: string
}

/** An attachment accepted for committing. */
export interface AcceptedAttachment {
  /** Repo-relative path, e.g. `public/static/images/my-post-1.jpg`. */
  path: string
  /** Site-absolute URL the post refers to it by, e.g. `/static/images/...`. */
  url: string
  kind: 'image' | 'document'
  /** The sender's original filename, for matching mentions in the body. */
  originalFilename: string
  bytes: Uint8Array
  /** Whether the part was embedded in the body. See `InboundAttachment`. */
  related?: boolean
  /** Metadata removed on the way in, for the pull request body. */
  strippedMetadata?: string[]
}

export interface RejectedAttachment {
  filename: string
  reason: string
}

/**
 * Which rule placed an image, for logging.
 *
 * Recorded rather than inferred because the cascade is deliberately
 * client-agnostic: no mail client is identified, and different clients populate
 * different subsets of the standard signals. Logging which rule fired is how we
 * find out from real mail whether one cascade keeps holding, or whether some
 * client keeps falling through to the append fallback — evidence for adding a
 * rule, instead of guessing at a client matrix up front.
 */
export interface Placement {
  filename: string
  /** `placeholder` and `mention` put the image in place; `appended` did not. */
  rule: 'placeholder' | 'mention' | 'appended'
  /** Whether the part was `multipart/related`, which only some clients set. */
  related: boolean
}

export interface AttachmentPlan {
  accepted: AcceptedAttachment[]
  rejected: RejectedAttachment[]
}

/** Where a site keeps its assets. */
export interface AssetPaths {
  /** Repo-relative directory for committed files. */
  directory: string
  /** URL prefix the site serves that directory at. */
  urlPrefix: string
}

/**
 * Decide which attachments may be committed, and under what names.
 *
 * Filenames are rebuilt from the post slug rather than taken from the sender:
 * an emailed filename is attacker-controlled, may contain path separators, and
 * in a flat shared assets directory is very likely to collide with something
 * already there — `IMG_0001.jpg` especially.
 */
export function planAttachments(
  attachments: InboundAttachment[],
  slug: string,
  paths: AssetPaths,
  options: { startIndex?: number } = {},
): AttachmentPlan {
  const accepted: AcceptedAttachment[] = []
  const rejected: RejectedAttachment[] = []

  // Numbering continues from an offset so a later reply can add more without
  // colliding with what the first message committed.
  let index = options.startIndex ?? 1
  let total = 0

  for (const attachment of attachments) {
    const mimeType = attachment.mimeType.toLowerCase().split(';')[0]!.trim()

    // Refused-with-a-reason before the general allowlist, so the sender is told
    // what to do rather than just that it did not work. An override set by
    // `convertAttachments` wins: it knows a conversion was tried and failed,
    // which the MIME type alone cannot express.
    const refusal = attachment.refusalOverride ?? REFUSED_TYPES[mimeType]
    if (refusal) {
      rejected.push({ filename: attachment.filename, reason: refusal })
      continue
    }

    const type = ALLOWED_TYPES[mimeType]
    if (!type) {
      rejected.push({
        filename: attachment.filename,
        reason: `unsupported type ${attachment.mimeType}`,
      })
      continue
    }

    if (attachment.bytes.length === 0) {
      rejected.push({ filename: attachment.filename, reason: 'empty file' })
      continue
    }
    if (attachment.bytes.length > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        filename: attachment.filename,
        reason: `too large (${formatBytes(attachment.bytes.length)}, limit ${formatBytes(MAX_ATTACHMENT_BYTES)})`,
      })
      continue
    }
    if (total + attachment.bytes.length > MAX_TOTAL_BYTES) {
      rejected.push({
        filename: attachment.filename,
        reason: `would exceed the ${formatBytes(MAX_TOTAL_BYTES)} total for one message`,
      })
      continue
    }

    total += attachment.bytes.length
    const name = `${slug}-${index}${type.extension}`
    index++

    // Location and device metadata is removed here rather than only in the
    // site's build: a photo carries GPS, and a repo whose posts are public is
    // the wrong place for it. Doing it at upload means the coordinates never
    // reach the repository even if a later build step is skipped or fails.
    const cleaned = stripImageMetadata(attachment.bytes, attachment.mimeType)

    accepted.push({
      path: `${paths.directory}/${name}`,
      url: `${paths.urlPrefix}/${name}`,
      kind: type.kind,
      originalFilename: attachment.filename,
      bytes: cleaned.bytes,
      ...(attachment.related ? { related: true } : {}),
      ...(cleaned.removed.length > 0 ? { strippedMetadata: cleaned.removed } : {}),
    })
  }

  return { accepted, rejected }
}

/** Turn accepted attachments into files for a commit. */
export function attachmentsToCommit(accepted: AcceptedAttachment[]): FileToCommit[] {
  return accepted.map((attachment) => ({ path: attachment.path, bytes: attachment.bytes }))
}

function formatBytes(count: number): string {
  if (count >= 1024 * 1024) return `${(count / (1024 * 1024)).toFixed(1)}MB`
  if (count >= 1024) return `${Math.round(count / 1024)}KB`
  return `${count} bytes`
}

/**
 * Place attachments in the post body.
 *
 * Two signals, in order:
 *
 *  1. **A placeholder the client left in the plaintext part.** A client that
 *     embeds an image writes a marker where it sat — Gmail writes
 *     `[image: name.jpg]` on its own line. Consuming the whole marker is what
 *     matters: replacing only the filename inside it leaves the brackets and
 *     the `image:` label behind as literal text.
 *  2. **A bare filename mention**, for genuinely plain-text mail where the
 *     author typed the name themselves.
 *
 * An embedded part (`related`) that matches neither is still appended rather
 * than dropped, so an image is never lost just because its client wrote no
 * placeholder — Apple Mail typically writes none at all.
 *
 * Documents are always appended as links, even when mentioned: replacing "see
 * report.pdf" with a link reads worse than a sentence followed by one.
 */
export function placeAttachments(
  body: string,
  accepted: AcceptedAttachment[],
): { body: string; inlined: number; placements: Placement[] } {
  if (accepted.length === 0) return { body, inlined: 0, placements: [] }

  let text = body
  let inlined = 0
  const trailing: AcceptedAttachment[] = []
  const placements: Placement[] = []

  for (const attachment of accepted) {
    const mention = findPlaceholder(text, attachment.originalFilename)
    if (attachment.kind === 'image' && mention !== null) {
      placements.push({
        filename: attachment.originalFilename,
        rule: mention.kind,
        related: attachment.related === true,
      })
      // Alt text is the original filename minus its extension: a poor
      // description, but better than empty, and the author can improve it in
      // the pull request.
      const alt = attachment.originalFilename.replace(/\.[^.]+$/, '')
      text = text.slice(0, mention.start) + `![${alt}](${attachment.url})` + text.slice(mention.end)
      inlined++
    } else {
      placements.push({
        filename: attachment.originalFilename,
        rule: 'appended',
        related: attachment.related === true,
      })
      trailing.push(attachment)
    }
  }

  if (trailing.length > 0) {
    const images = trailing.filter((attachment) => attachment.kind === 'image')
    const documents = trailing.filter((attachment) => attachment.kind === 'document')
    const sections: string[] = []

    if (images.length > 0) {
      sections.push(
        `## ${images.length === 1 ? 'Image' : 'Images'}`,
        '',
        ...images.map((image) => `![${image.originalFilename.replace(/\.[^.]+$/, '')}](${image.url})`),
      )
    }
    if (documents.length > 0) {
      if (sections.length > 0) sections.push('')
      sections.push(
        `## ${documents.length === 1 ? 'Attachment' : 'Attachments'}`,
        '',
        ...documents.map((doc) => `- [${doc.originalFilename}](${doc.url})`),
      )
    }

    text = `${text.replace(/\s+$/, '')}\n\n${sections.join('\n')}\n`
  }

  return { body: text, inlined, placements }
}

/**
 * Find where an image belongs in the body, if the text says.
 *
 * Prefers a client-written placeholder wrapping the filename — `[image:
 * name.jpg]`, `[cid:name.jpg]`, `<name.jpg>` — over a bare mention, and returns
 * the span of the *whole* marker so it is consumed rather than left around the
 * inserted image. The wrapper forms are matched generically rather than per
 * client: the bracketed-label convention is shared, only the label differs.
 *
 * Matched case-insensitively and only outside code spans and existing links, so
 * a filename inside a code block is left as written.
 */
function findPlaceholder(
  text: string,
  filename: string,
): { start: number; end: number; kind: 'placeholder' | 'mention' } | null {
  if (!filename) return null

  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // A bracketed marker with an optional `label:` prefix, then the bare name as
  // a fallback. Ordered, so the widest match wins.
  const pattern = new RegExp(
    `\\[[ \\t]*(?:[A-Za-z-]+[ \\t]*:[ \\t]*)?${escaped}[ \\t]*\\]` +
      `|<[ \\t]*(?:cid:[ \\t]*)?${escaped}[ \\t]*>` +
      `|${escaped}`,
    'i',
  )

  // Only search the unprotected parts, but report offsets in the full string.
  // A fully-parenthesised split pattern puts the delimiters at odd indices, so
  // parity identifies them — rather than re-testing each part, which would
  // advance a global regex's lastIndex and make the result order-dependent.
  const PROTECTED = /(```[\s\S]*?```|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\))/g
  let cursor = 0
  const parts = text.split(PROTECTED)
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!
    if (index % 2 === 0) {
      const match = pattern.exec(part)
      if (match) {
        // A match longer than the bare filename means a wrapper was consumed.
        const kind = match[0].length > filename.length ? 'placeholder' : 'mention'
        return {
          start: cursor + match.index,
          end: cursor + match.index + match[0].length,
          kind,
        }
      }
    }
    cursor += part.length
  }
  return null
}
