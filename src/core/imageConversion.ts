import type { InboundAttachment } from './attachments.ts'

/**
 * Converting formats a browser cannot render into ones it can, before anything
 * is committed.
 *
 * HEIC is the whole reason this exists. An iPhone shooting in its default format
 * produces HEIC, iOS Gmail attaches it as HEIC, and no browser renders it — so
 * without conversion the choice is committing a broken image or refusing the
 * photo and telling the sender to change a camera setting.
 *
 * The conversion itself is host-specific, so this module defines only the port:
 * `ImageConverter` is implemented by an adapter (see
 * `adapters/cloudflare/imageConverter.ts`), and everything here stays pure and
 * testable with a fake.
 */

/** A converter's successful result. */
export interface ConvertedImage {
  bytes: Uint8Array
  mimeType: 'image/jpeg'
  /**
   * The source format as the converter actually determined it, which may differ
   * from what the sender's client declared. Used for the note in the pull
   * request, so it reports what was really converted rather than what was
   * claimed.
   */
  sourceFormat: string
}

/**
 * Turning bytes a browser cannot render into a JPEG.
 *
 * JPEG specifically, not a general `transform(options)`: it is the only output
 * the pipeline wants, and a general interface would invite host-specific option
 * names into core.
 */
export interface ImageConverter {
  /**
   * Convert to JPEG, or return `null` when declining.
   *
   * **Never throws.** Declining is the expected path, not an exceptional one:
   * no binding configured, the site opted out, the image is past a size or
   * dimension limit, or the bytes are not really an image. Returning `null`
   * makes the caller's fallback mandatory, where an exception would make it
   * easy to forget — and the fallback (refuse the attachment, keep the post) is
   * the behaviour that already exists.
   */
  toJpeg(bytes: Uint8Array, declaredMimeType: string): Promise<ConvertedImage | null>
}

/** What was converted, for the pull request body. */
export interface ConversionNote {
  /** The sender's original filename, e.g. `IMG_0001.HEIC`. */
  filename: string
  /** Source format, as the converter determined it. */
  from: string
}

/**
 * ISO base media file format brands that mean "this is a HEIF-family image".
 *
 * Deliberately an allowlist. `ftyp` fronts every ISO-BMFF file, MP4 and
 * QuickTime included, so matching the box alone would hand a video to the
 * converter. `mif1`/`msf1` are the generic HEIF brands an iPhone also uses.
 */
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
])

/**
 * Whether bytes look like a HEIF-family image, by reading the container.
 *
 * A content check rather than a declaration check, because the declaration is
 * unreliable in exactly the case that matters: senders' clients mislabel
 * attachments, and some send `application/octet-stream` for everything. The
 * layout is `[4-byte size]['ftyp'][4-byte brand]`, so the brand is at offset 8.
 */
export function looksLikeHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const ascii = (start: number, end: number): string =>
    String.fromCharCode(...bytes.subarray(start, end))
  if (ascii(4, 8) !== 'ftyp') return false
  return HEIF_BRANDS.has(ascii(8, 12).toLowerCase())
}

/** MIME types that name a HEIF-family image outright. */
const HEIF_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])

/**
 * Types carrying no useful information, where the filename and magic bytes are
 * all there is to go on. Gmail has been observed sending the first of these.
 */
const VAGUE_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])

/**
 * Whether an attachment is a candidate for conversion.
 *
 * Three ways to qualify, because any one of them alone misses real mail: the
 * declared type, a vague type plus a telling filename, or the bytes themselves.
 */
function isConversionCandidate(attachment: InboundAttachment): boolean {
  const declared = attachment.mimeType.toLowerCase().split(';')[0]!.trim()
  if (HEIF_TYPES.has(declared)) return true
  if (VAGUE_TYPES.has(declared) && /\.hei[cf]$/i.test(attachment.filename)) return true
  return looksLikeHeic(attachment.bytes)
}

/**
 * Convert what needs converting, leaving everything else exactly as it arrived.
 *
 * Runs before `planAttachments` so that function stays synchronous and pure —
 * allow/refuse/size/name decisions are a different concern from transforming
 * bytes, and keeping them apart is what lets the plan be tested without any
 * I/O.
 *
 * Every failure path leaves the original attachment in place, which
 * `planAttachments` then refuses through `REFUSED_TYPES` exactly as it does
 * today. `refusalOverride` is set only when a conversion was genuinely
 * attempted and failed, so the sender is not told to change a camera setting
 * that was not the problem.
 */
export async function convertAttachments(
  attachments: InboundAttachment[],
  converter?: ImageConverter,
): Promise<{ attachments: InboundAttachment[]; conversions: ConversionNote[] }> {
  // No converter is the common case for a site that has not enabled it, and
  // returning the input untouched costs nothing.
  if (!converter) return { attachments, conversions: [] }

  const out: InboundAttachment[] = []
  const conversions: ConversionNote[] = []

  for (const attachment of attachments) {
    if (!isConversionCandidate(attachment)) {
      // Anything a browser can already render is left alone. A JPEG must not
      // make a round trip: it would cost a transformation, re-encode lossily,
      // and discard the ICC profile that `stripImageMetadata` preserves.
      out.push(attachment)
      continue
    }

    const converted = await converter.toJpeg(attachment.bytes, attachment.mimeType)
    if (!converted) {
      out.push({
        ...attachment,
        refusalOverride:
          'this image could not be converted to a format browsers render, so it was not committed',
      })
      continue
    }

    out.push({ ...attachment, mimeType: converted.mimeType, bytes: converted.bytes })
    conversions.push({ filename: attachment.filename, from: converted.sourceFormat })
  }

  return { attachments: out, conversions }
}
