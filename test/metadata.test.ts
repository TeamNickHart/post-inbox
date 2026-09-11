import { describe, expect, it } from 'vitest'
import { stripImageMetadata, stripsCleanly } from '../src/core/metadata.ts'

/**
 * Build a JPEG with a single-entry EXIF IFD, little-endian, plus optional GPS
 * and MPF segments. Synthetic, but the byte layout is the one a camera writes.
 */
function jpeg(options: { orientation?: number; gps?: boolean; mpf?: boolean; icc?: boolean } = {}) {
  const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff]
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]

  const entries: number[] = []
  let count = 0
  if (options.orientation !== undefined) {
    entries.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(options.orientation), 0, 0)
    count++
  }
  if (options.gps) {
    entries.push(...u16(0x8825), ...u16(4), ...u32(1), ...u32(0))
    count++
  }
  const tiff = [0x49, 0x49, ...u16(0x2a), ...u32(8), ...u16(count), ...entries, ...u32(0)]
  const exifPayload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const exifLength = exifPayload.length + 2

  const out: number[] = [0xff, 0xd8]
  out.push(0xff, 0xe1, (exifLength >> 8) & 0xff, exifLength & 0xff, ...exifPayload)

  if (options.icc) {
    const icc = [...'ICC_PROFILE'].map((c) => c.charCodeAt(0))
    const length = icc.length + 2
    out.push(0xff, 0xe2, (length >> 8) & 0xff, length & 0xff, ...icc)
  }
  if (options.mpf) {
    const mpf = [...'MPF\0'].map((c) => c.charCodeAt(0))
    const length = mpf.length + 2
    out.push(0xff, 0xe2, (length >> 8) & 0xff, length & 0xff, ...mpf)
  }

  out.push(0xff, 0xda, 0, 2, 0xff, 0xd9)
  return new Uint8Array(out)
}

/** Read orientation back by walking segments and the IFD, not by byte search. */
function orientationOf(bytes: Uint8Array): number | null {
  let offset = 2
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) break
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    if (marker === 0xe1 && bytes[offset + 4] === 0x45) {
      const tiff = offset + 10
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const little = bytes[tiff] === 0x49
      const ifd = view.getUint32(tiff + 4, little)
      const count = view.getUint16(tiff + ifd, little)
      for (let index = 0; index < count; index++) {
        const entry = tiff + ifd + 2 + index * 12
        if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little)
      }
      return null
    }
    offset += 2 + length
  }
  return null
}

function segmentIds(bytes: Uint8Array): string[] {
  const ids: string[] = []
  let offset = 2
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1]!
    if (marker === 0xda || marker === 0xd9) break
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    const tag =
      marker === 0xe2
        ? String.fromCharCode(...bytes.subarray(offset + 4, offset + 15)).replace(/[^\x20-\x7e]/g, '')
        : ''
    ids.push(`ff${marker.toString(16)}${tag ? `(${tag})` : ''}`)
    offset += 2 + length
  }
  return ids
}

describe('stripImageMetadata — GPS', () => {
  it('removes the GPS IFD', () => {
    const result = stripImageMetadata(jpeg({ orientation: 1, gps: true }), 'image/jpeg')
    expect(result.removed).toContain('GPS')
    expect(segmentIds(result.bytes).filter((id) => id.startsWith('ffe1'))).toHaveLength(1)
  })

  it('reports what it removed, for the pull request body', () => {
    const result = stripImageMetadata(jpeg({ orientation: 1, gps: true }), 'image/jpeg')
    expect(result.removed).toEqual(expect.arrayContaining(['GPS', 'EXIF metadata']))
  })
})

describe('stripImageMetadata — orientation must survive', () => {
  // Dropping EXIF wholesale is the obvious approach and it renders every
  // portrait photo sideways. These are the values a camera actually writes.
  for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`preserves orientation ${value}`, () => {
      const result = stripImageMetadata(jpeg({ orientation: value, gps: true }), 'image/jpeg')
      expect(orientationOf(result.bytes)).toBe(value)
    })
  }

  it('drops an out-of-range orientation rather than propagating junk', () => {
    const result = stripImageMetadata(jpeg({ orientation: 99 }), 'image/jpeg')
    expect(orientationOf(result.bytes)).toBeNull()
  })
})

describe('stripImageMetadata — APP2 is two different things', () => {
  it('keeps the ICC colour profile, since dropping it shifts wide-gamut colour', () => {
    const result = stripImageMetadata(jpeg({ orientation: 1, icc: true }), 'image/jpeg')
    expect(segmentIds(result.bytes).some((id) => id.includes('ICC_PROFILE'))).toBe(true)
  })

  it('removes an MPF index, which shares the APP2 marker with ICC', () => {
    // Told apart by the segment identifier, not the marker number — MPF can
    // carry offsets to a second embedded image.
    const result = stripImageMetadata(jpeg({ orientation: 1, mpf: true }), 'image/jpeg')
    expect(result.removed).toContain('MPF')
    expect(segmentIds(result.bytes).some((id) => id.includes('MPF'))).toBe(false)
  })

  it('keeps ICC while removing MPF when both are present', () => {
    const result = stripImageMetadata(jpeg({ orientation: 1, icc: true, mpf: true }), 'image/jpeg')
    const ids = segmentIds(result.bytes)
    expect(ids.some((id) => id.includes('ICC_PROFILE'))).toBe(true)
    expect(ids.some((id) => id.includes('MPF'))).toBe(false)
  })
})

describe('stripImageMetadata — formats it cannot clean', () => {
  it('reports which formats strip cleanly', () => {
    expect(stripsCleanly('image/jpeg')).toBe(true)
    expect(stripsCleanly('image/png')).toBe(true)
    expect(stripsCleanly('image/webp')).toBe(true)
    // HEIC is an ISO base media container: metadata is structural, not a
    // removable segment, so nothing is stripped and GPS survives.
    expect(stripsCleanly('image/heic')).toBe(false)
    expect(stripsCleanly('image/heif')).toBe(false)
  })

  it('passes an unhandled format through untouched rather than mangling it', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const result = stripImageMetadata(bytes, 'image/heic')
    expect(result.bytes).toEqual(bytes)
    expect(result.removed).toEqual([])
  })

  it('leaves bytes that are not the declared format alone', () => {
    const notJpeg = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    expect(stripImageMetadata(notJpeg, 'image/jpeg').bytes).toEqual(notJpeg)
  })
})

describe('stripImageMetadata — PNG and WebP', () => {
  it('removes PNG text and EXIF chunks, keeping the signature valid', () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
      0, 0, 0, 4, 0x74, 0x45, 0x58, 0x74, 0x61, 0x62, 0x63, 0x64, 0, 0, 0, 0,
      0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    const result = stripImageMetadata(png, 'image/png')
    expect(result.removed).toContain('tEXt')
    expect([...result.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(result.bytes.length).toBeLessThan(png.length)
  })

  it('removes a WebP EXIF chunk and fixes up the RIFF size', () => {
    const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
    const body = [0x56, 0x50, 0x38, 0x20, ...u32(4), 1, 2, 3, 4, 0x45, 0x58, 0x49, 0x46, ...u32(4), 9, 9, 9, 9]
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, ...u32(4 + body.length), 0x57, 0x45, 0x42, 0x50, ...body])

    const result = stripImageMetadata(webp, 'image/webp')
    expect(result.removed).toContain('EXIF')
    // A stale RIFF size makes the file unreadable, so it must be rewritten.
    const declared = new DataView(result.bytes.buffer, result.bytes.byteOffset).getUint32(4, true)
    expect(declared).toBe(result.bytes.length - 8)
  })
})
