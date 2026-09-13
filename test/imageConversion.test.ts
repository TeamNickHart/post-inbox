import { describe, expect, it } from 'vitest'
import { planAttachments, type InboundAttachment } from '../src/core/attachments.ts'
import {
  convertAttachments,
  looksLikeHeic,
  type ImageConverter,
} from '../src/core/imageConversion.ts'

const paths = { directory: 'public/static/images', urlPrefix: '/static/images' }

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

/** An ISO-BMFF header with the given brand, which is all the detector reads. */
const ftyp = (brand: string, extra = 0): Uint8Array => {
  const bytes = new Uint8Array(12 + extra)
  bytes.set([0x00, 0x00, 0x00, 0x18], 0)
  bytes.set([...'ftyp'].map((c) => c.charCodeAt(0)), 4)
  bytes.set([...brand].map((c) => c.charCodeAt(0)), 8)
  return bytes
}

const file = (overrides: Partial<InboundAttachment> = {}): InboundAttachment => ({
  filename: 'IMG_1234.HEIC',
  mimeType: 'image/heic',
  bytes: ftyp('heic'),
  ...overrides,
})

/** Succeeds, reporting whatever source format it was told to claim. */
const working = (sourceFormat = 'image/heic'): ImageConverter => ({
  toJpeg: async () => ({ bytes: JPEG_BYTES, mimeType: 'image/jpeg', sourceFormat }),
})

/** Declines everything, as the real one does on any error. */
const declining: ImageConverter = { toJpeg: async () => null }

describe('looksLikeHeic', () => {
  it('recognises the HEIF-family brands an iPhone writes', () => {
    for (const brand of ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1']) {
      expect(looksLikeHeic(ftyp(brand)), brand).toBe(true)
    }
  })

  it('does not match video or other ISO base media files', () => {
    // `ftyp` fronts MP4 and QuickTime too. Matching the box rather than the
    // brand would hand a video to the converter.
    for (const brand of ['isom', 'mp42', 'qt  ', 'avc1', 'M4V ']) {
      expect(looksLikeHeic(ftyp(brand)), brand).toBe(false)
    }
  })

  it('does not match a JPEG, a PNG, or anything too short to have a brand', () => {
    expect(looksLikeHeic(JPEG_BYTES)).toBe(false)
    expect(looksLikeHeic(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      false,
    )
    expect(looksLikeHeic(new Uint8Array([]))).toBe(false)
    expect(looksLikeHeic(new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74]))).toBe(false)
  })
})

describe('convertAttachments — what gets converted', () => {
  it('converts an attachment the client declared as HEIC', async () => {
    const result = await convertAttachments([file()], working())
    expect(result.attachments[0]!.mimeType).toBe('image/jpeg')
    expect(result.attachments[0]!.bytes).toEqual(JPEG_BYTES)
    expect(result.conversions).toEqual([{ filename: 'IMG_1234.HEIC', from: 'image/heic' }])
  })

  it('converts when the type is vague but the filename and bytes say HEIC', async () => {
    // Gmail has been seen sending `application/octet-stream` for attachments.
    const result = await convertAttachments(
      [file({ mimeType: 'application/octet-stream' })],
      working(),
    )
    expect(result.attachments[0]!.mimeType).toBe('image/jpeg')
  })

  it('converts on the magic bytes even when the type and filename both lie', async () => {
    const result = await convertAttachments(
      [file({ filename: 'holiday.jpg', mimeType: 'image/jpeg', bytes: ftyp('heic') })],
      working(),
    )
    expect(result.attachments[0]!.mimeType).toBe('image/jpeg')
    expect(result.conversions).toHaveLength(1)
  })

  it('reports the source format the converter determined, not the declared one', async () => {
    // The declared type is what the client claimed; the converter decoded the
    // file. The pull request should say what was really converted.
    const result = await convertAttachments(
      [file({ mimeType: 'application/octet-stream' })],
      working('image/heif'),
    )
    expect(result.conversions[0]!.from).toBe('image/heif')
  })

  it('never sends a renderable image to the converter', async () => {
    // A JPEG round trip would cost a transformation, re-encode lossily, and
    // throw away the ICC profile that stripImageMetadata preserves.
    const exploding: ImageConverter = {
      toJpeg: async () => {
        throw new Error('the converter should not have been called')
      },
    }
    const renderable = [
      file({ filename: 'a.jpg', mimeType: 'image/jpeg', bytes: JPEG_BYTES }),
      file({ filename: 'b.png', mimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50]) }),
      file({ filename: 'c.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([0x25]) }),
    ]
    const result = await convertAttachments(renderable, exploding)
    expect(result.attachments).toEqual(renderable)
    expect(result.conversions).toEqual([])
  })

  it('leaves everything untouched when no converter is configured', async () => {
    const input = [file()]
    const result = await convertAttachments(input, undefined)
    expect(result.attachments).toBe(input)
    expect(result.conversions).toEqual([])
  })
})

describe('convertAttachments — failure leaves the post intact', () => {
  it('marks a failed conversion with a reason that is actually true', async () => {
    const result = await convertAttachments([file()], declining)
    const reason = result.attachments[0]!.refusalOverride
    expect(reason).toBeDefined()
    // The camera setting is not the problem when conversion itself failed, so
    // the message must not name it.
    expect(reason).not.toMatch(/Most Compatible/)
    expect(result.conversions).toEqual([])
  })

  it('keeps the original bytes and type when conversion fails', async () => {
    const result = await convertAttachments([file()], declining)
    expect(result.attachments[0]!.mimeType).toBe('image/heic')
    expect(result.attachments[0]!.bytes).toEqual(ftyp('heic'))
  })
})

describe('convertAttachments feeding planAttachments', () => {
  it('commits a converted HEIC as a .jpg named from the slug', async () => {
    const converted = await convertAttachments([file()], working())
    const plan = planAttachments(converted.attachments, 'my-post', paths)

    expect(plan.rejected).toEqual([])
    expect(plan.accepted).toHaveLength(1)
    // The extension comes from the MIME table, so conversion renames for free.
    expect(plan.accepted[0]!.path).toBe('public/static/images/my-post-1.jpg')
    expect(plan.accepted[0]!.url).toBe('/static/images/my-post-1.jpg')
    // The sender's filename is kept for matching mentions in the body, which is
    // why it must NOT be rewritten to .jpg.
    expect(plan.accepted[0]!.originalFilename).toBe('IMG_1234.HEIC')
  })

  it('refuses with the conversion-failed reason, not the camera-setting advice', async () => {
    const converted = await convertAttachments([file()], declining)
    const plan = planAttachments(converted.attachments, 'my-post', paths)

    expect(plan.accepted).toEqual([])
    expect(plan.rejected[0]!.reason).toMatch(/could not be converted/)
    expect(plan.rejected[0]!.reason).not.toMatch(/Most Compatible/)
  })

  it('still gives the camera-setting advice when there is no converter at all', async () => {
    // A site running without conversion keeps today's behaviour exactly.
    const converted = await convertAttachments([file()], undefined)
    const plan = planAttachments(converted.attachments, 'my-post', paths)

    expect(plan.accepted).toEqual([])
    expect(plan.rejected[0]!.reason).toMatch(/Most Compatible/)
  })
})
