/**
 * Strip location and identifying metadata from image bytes before committing.
 *
 * Done at upload rather than only in the site's build, deliberately: a photo
 * from a phone carries GPS coordinates, and a repo whose posts are public is
 * the wrong place for them. Doing it here means the coordinates never reach
 * the repository at all, even if a later build step is skipped, fails, or has
 * not been written yet.
 *
 * What is kept, and why it matters: **EXIF orientation**. A photo shot in
 * portrait records `Orientation = 6` or `8`, and dropping that tag makes the
 * image render sideways. Stripping EXIF wholesale is the obvious approach and
 * it visibly corrupts half of all phone photos, so this rebuilds the EXIF
 * block with orientation preserved instead.
 *
 * Scope by format:
 *  - **JPEG** — the EXIF IFD is rewritten: GPS, thumbnails and maker notes are
 *    dropped, orientation kept.
 *  - **PNG / WebP** — metadata lives in named chunks, which are removed
 *    wholesale. Neither format carries an orientation tag that browsers honour,
 *    so there is nothing to preserve.
 *  - **HEIC / HEIF** — an ISO base media container where metadata is
 *    structural rather than a removable segment. Not handled; see
 *    `stripsCleanly`.
 */

/** Formats this module can actually clean. */
export function stripsCleanly(mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(';')[0]!.trim()
  return ['image/jpeg', 'image/png', 'image/webp'].includes(type)
}

export interface StripResult {
  bytes: Uint8Array
  /** What was removed, for logging and the pull request body. */
  removed: string[]
}

/** Remove metadata from image bytes, returning them unchanged if unrecognised. */
export function stripImageMetadata(bytes: Uint8Array, mimeType: string): StripResult {
  const type = mimeType.toLowerCase().split(';')[0]!.trim()
  if (type === 'image/jpeg') return stripJpeg(bytes)
  if (type === 'image/png') return stripPng(bytes)
  if (type === 'image/webp') return stripWebp(bytes)
  return { bytes, removed: [] }
}

// --- JPEG -------------------------------------------------------------------

const JPEG_SOI = 0xd8
const JPEG_SOS = 0xda
const JPEG_EOI = 0xd9
const JPEG_APP0 = 0xe0
const JPEG_APP1 = 0xe1
const JPEG_APP2 = 0xe2
const JPEG_COM = 0xfe

/**
 * Walk a JPEG's marker segments, rewriting APP1 (EXIF) and dropping the other
 * metadata carriers.
 *
 * APP0 (JFIF) and APP2 (ICC colour profile) are kept: JFIF is structural, and
 * dropping an ICC profile shifts the colours of a wide-gamut photo.
 */
function stripJpeg(bytes: Uint8Array): StripResult {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== JPEG_SOI) {
    return { bytes, removed: [] }
  }

  const out: Uint8Array[] = [bytes.subarray(0, 2)]
  const removed: string[] = []
  let offset = 2

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]!

    // Scan data begins here; everything from this point is image data.
    if (marker === JPEG_SOS || marker === JPEG_EOI) {
      out.push(bytes.subarray(offset))
      offset = bytes.length
      break
    }

    // Markers without a length field.
    if (marker >= 0xd0 && marker <= 0xd9) {
      out.push(bytes.subarray(offset, offset + 2))
      offset += 2
      continue
    }

    if (offset + 4 > bytes.length) break
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    const end = offset + 2 + length
    if (length < 2 || end > bytes.length) break

    const segment = bytes.subarray(offset, end)

    if (marker === JPEG_APP1 && isExif(segment)) {
      const rebuilt = rebuildExif(segment)
      if (rebuilt) {
        out.push(rebuilt.segment)
        removed.push(...rebuilt.removed)
      } else {
        removed.push('EXIF')
      }
    } else if (marker === JPEG_APP1) {
      // APP1 that is not EXIF is XMP, which carries its own location fields.
      removed.push('XMP')
    } else if (marker === JPEG_COM) {
      removed.push('comment')
    } else if (marker > JPEG_APP2 && marker <= 0xef) {
      // APP3..APP15: Photoshop resources, maker notes, and similar.
      removed.push(`APP${marker - JPEG_APP0}`)
    } else {
      out.push(segment)
    }

    offset = end
  }

  if (offset < bytes.length) out.push(bytes.subarray(offset))
  return { bytes: concat(out), removed: dedupe(removed) }
}

function isExif(segment: Uint8Array): boolean {
  if (segment.length < 10) return false
  return (
    segment[4] === 0x45 && // E
    segment[5] === 0x78 && // x
    segment[6] === 0x69 && // i
    segment[7] === 0x66 && // f
    segment[8] === 0x00
  )
}

/**
 * Rebuild an EXIF APP1 segment containing only the orientation tag.
 *
 * Rather than editing the original IFD in place — which means fixing up every
 * offset that points past the removed entries — a minimal TIFF structure is
 * written from scratch with the one tag worth keeping. That sidesteps the whole
 * class of offset bugs, and anything not explicitly copied is gone by
 * construction: GPS, timestamps, device model, serial numbers, maker notes and
 * the embedded thumbnail.
 */
function rebuildExif(segment: Uint8Array): { segment: Uint8Array; removed: string[] } | null {
  const tiff = 10 // 2 marker + 2 length + 6 "Exif\0\0"
  if (segment.length < tiff + 8) return null

  const little = segment[tiff] === 0x49 && segment[tiff + 1] === 0x49
  const big = segment[tiff] === 0x4d && segment[tiff + 1] === 0x4d
  if (!little && !big) return null

  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength)
  const read16 = (at: number) => view.getUint16(at, little)
  const read32 = (at: number) => view.getUint32(at, little)

  const removed: string[] = []
  let orientation: number | null = null

  try {
    const ifdOffset = read32(tiff + 4)
    const entryCount = read16(tiff + ifdOffset)

    for (let index = 0; index < entryCount; index++) {
      const entry = tiff + ifdOffset + 2 + index * 12
      if (entry + 12 > segment.length) break
      const tag = read16(entry)

      if (tag === 0x0112) {
        const value = read16(entry + 8)
        // Only the eight defined values mean anything; anything else is junk
        // and is safer dropped than propagated.
        if (value >= 1 && value <= 8) orientation = value
      } else if (tag === 0x8825) {
        removed.push('GPS')
      } else if (tag === 0x010f || tag === 0x0110) {
        removed.push('device')
      } else if (tag === 0x0132 || tag === 0x9003) {
        removed.push('timestamp')
      }
    }
  } catch {
    // A malformed IFD is a reason to drop EXIF entirely, not to trust it.
    return null
  }

  removed.push('EXIF metadata')

  // A minimal big-endian TIFF: header, one IFD entry, null next-IFD pointer.
  const body = new Uint8Array(8 + 2 + 12 + 4)
  const out = new DataView(body.buffer)
  body[0] = 0x4d
  body[1] = 0x4d // "MM" big-endian
  out.setUint16(2, 0x002a, false) // TIFF magic
  out.setUint32(4, 8, false) // first IFD at offset 8
  out.setUint16(8, orientation === null ? 0 : 1, false) // entry count

  if (orientation !== null) {
    out.setUint16(10, 0x0112, false) // Orientation
    out.setUint16(12, 3, false) // SHORT
    out.setUint32(14, 1, false) // count
    out.setUint16(18, orientation, false) // value, left-aligned in 4 bytes
    out.setUint16(20, 0, false)
    out.setUint32(22, 0, false) // no next IFD
  } else {
    out.setUint32(10, 0, false)
  }

  const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) // "Exif\0\0"
  const payloadLength = 2 + header.length + body.length
  const rebuilt = new Uint8Array(2 + payloadLength)
  rebuilt[0] = 0xff
  rebuilt[1] = JPEG_APP1
  rebuilt[2] = (payloadLength >> 8) & 0xff
  rebuilt[3] = payloadLength & 0xff
  rebuilt.set(header, 4)
  rebuilt.set(body, 4 + header.length)

  return { segment: rebuilt, removed: dedupe(removed) }
}

// --- PNG --------------------------------------------------------------------

/** Chunks that carry text, location or timing information. */
const PNG_STRIP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'])

function stripPng(bytes: Uint8Array): StripResult {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8 || !signature.every((byte, index) => bytes[index] === byte)) {
    return { bytes, removed: [] }
  }

  const out: Uint8Array[] = [bytes.subarray(0, 8)]
  const removed: string[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length // length + type + data + crc
    if (end > bytes.length) break

    if (PNG_STRIP.has(name)) removed.push(name)
    else out.push(bytes.subarray(offset, end))

    offset = end
    if (name === 'IEND') break
  }

  return { bytes: concat(out), removed: dedupe(removed) }
}

// --- WebP -------------------------------------------------------------------

/** RIFF chunks carrying metadata. */
const WEBP_STRIP = new Set(['EXIF', 'XMP '])

function stripWebp(bytes: Uint8Array): StripResult {
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...bytes.subarray(at, at + length))
  if (bytes.length < 12 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') {
    return { bytes, removed: [] }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kept: Uint8Array[] = []
  const removed: string[] = []
  let offset = 12

  while (offset + 8 <= bytes.length) {
    const name = ascii(offset, 4)
    const size = view.getUint32(offset + 4, true)
    // RIFF chunks are padded to an even length.
    const end = offset + 8 + size + (size % 2)
    if (end > bytes.length) break

    if (WEBP_STRIP.has(name)) removed.push(name.trim())
    else kept.push(bytes.subarray(offset, Math.min(end, bytes.length)))

    offset = end
  }

  if (removed.length === 0) return { bytes, removed: [] }

  // The RIFF header carries the total payload size, so it must be rewritten.
  const payload = concat(kept)
  const result = new Uint8Array(12 + payload.length)
  result.set(bytes.subarray(0, 12))
  new DataView(result.buffer).setUint32(4, 4 + payload.length, true)
  result.set(payload, 12)

  return { bytes: result, removed: dedupe(removed) }
}

// --- helpers ----------------------------------------------------------------

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    result.set(part, at)
    at += part.length
  }
  return result
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}
