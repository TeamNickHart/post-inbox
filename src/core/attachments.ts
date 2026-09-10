import type { FileToCommit } from './github.ts'

/**
 * Email attachments becoming files in the site repo.
 *
 * Scope, deliberately: this commits attachments as they arrive. It does not
 * convert, resize, or re-encode anything. Image processing belongs in the
 * site's build — a GitHub Action on the pull request has a full Linux runner
 * with `sharp` and native tools, where a Worker has neither and cannot execute
 * native binaries at all. Keeping conversion out of here also means it applies
 * to every image in the repo however it arrived, including images added later
 * by a reply, without that path knowing anything about it.
 *
 * A HEIC from an iPhone therefore lands as a HEIC. That is a real gap until the
 * build step exists, and it is visible rather than silent: the PR shows a file
 * the site cannot render.
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
  'image/heic': { extension: '.heic', kind: 'image' },
  'image/heif': { extension: '.heif', kind: 'image' },
  'application/pdf': { extension: '.pdf', kind: 'document' },
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
}

export interface RejectedAttachment {
  filename: string
  reason: string
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
    const type = ALLOWED_TYPES[attachment.mimeType.toLowerCase().split(';')[0]!.trim()]
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

    accepted.push({
      path: `${paths.directory}/${name}`,
      url: `${paths.urlPrefix}/${name}`,
      kind: type.kind,
      originalFilename: attachment.filename,
      bytes: attachment.bytes,
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
 * An image whose filename the author mentioned goes where they mentioned it —
 * that mention is the only placement signal a plaintext email offers, since
 * there is no true inline embedding the way HTML mail has. Everything else is
 * appended under a heading.
 *
 * Documents are always appended as links, even when mentioned: replacing "see
 * report.pdf" with a link reads worse than a sentence followed by one.
 */
export function placeAttachments(
  body: string,
  accepted: AcceptedAttachment[],
): { body: string; inlined: number } {
  if (accepted.length === 0) return { body, inlined: 0 }

  let text = body
  let inlined = 0
  const trailing: AcceptedAttachment[] = []

  for (const attachment of accepted) {
    const mention = findMention(text, attachment.originalFilename)
    if (attachment.kind === 'image' && mention !== null) {
      // Alt text is the original filename minus its extension: a poor
      // description, but better than empty, and the author can improve it in
      // the pull request.
      const alt = attachment.originalFilename.replace(/\.[^.]+$/, '')
      text = text.slice(0, mention.start) + `![${alt}](${attachment.url})` + text.slice(mention.end)
      inlined++
    } else {
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

  return { body: text, inlined }
}

/**
 * Find where the author mentioned a filename, if they did.
 *
 * Matched case-insensitively and only outside code spans and existing links, so
 * a filename inside a code block is left as written. The whole mention is
 * replaced, so "see IMG_1234.jpg here" becomes "see ![IMG_1234](...) here".
 */
function findMention(text: string, filename: string): { start: number; end: number } | null {
  if (!filename) return null

  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(escaped, 'i')

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
      if (match) return { start: cursor + match.index, end: cursor + match.index + match[0].length }
    }
    cursor += part.length
  }
  return null
}
