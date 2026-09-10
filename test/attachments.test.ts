import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_BYTES,
  placeAttachments,
  planAttachments,
  type InboundAttachment,
} from '../src/core/attachments.ts'

const paths = { directory: 'public/static/images', urlPrefix: '/static/images' }

const file = (overrides: Partial<InboundAttachment> = {}): InboundAttachment => ({
  filename: 'IMG_1234.jpg',
  mimeType: 'image/jpeg',
  bytes: new Uint8Array([0xff, 0xd8, 0xff]),
  ...overrides,
})

describe('planAttachments — what is allowed', () => {
  it('accepts the image types a phone or laptop actually sends', () => {
    const types = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']
    for (const mimeType of types) {
      const plan = planAttachments([file({ mimeType })], 'a-post', paths)
      expect(plan.accepted, mimeType).toHaveLength(1)
    }
  })

  it('accepts a pdf as a document rather than an image', () => {
    const plan = planAttachments(
      [file({ filename: 'report.pdf', mimeType: 'application/pdf' })],
      'a-post',
      paths,
    )
    expect(plan.accepted[0]!.kind).toBe('document')
  })

  it('refuses an unlisted type rather than accepting it by default', () => {
    // An allowlist, not a denylist: a type nobody thought about is refused.
    for (const mimeType of ['application/zip', 'text/html', 'application/x-sh', 'video/mp4']) {
      const plan = planAttachments([file({ mimeType })], 'a-post', paths)
      expect(plan.accepted, mimeType).toHaveLength(0)
      expect(plan.rejected[0]!.reason).toMatch(/unsupported type/)
    }
  })

  it('tolerates a mime type carrying parameters', () => {
    const plan = planAttachments([file({ mimeType: 'image/jpeg; name="x.jpg"' })], 'a-post', paths)
    expect(plan.accepted).toHaveLength(1)
  })

  it('is case-insensitive about the mime type', () => {
    expect(planAttachments([file({ mimeType: 'IMAGE/JPEG' })], 'a-post', paths).accepted).toHaveLength(1)
  })

  it('rejects an empty file', () => {
    const plan = planAttachments([file({ bytes: new Uint8Array(0) })], 'a-post', paths)
    expect(plan.rejected[0]!.reason).toBe('empty file')
  })

  it('rejects one file over the per-attachment cap', () => {
    const plan = planAttachments(
      [file({ bytes: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) })],
      'a-post',
      paths,
    )
    expect(plan.rejected[0]!.reason).toMatch(/too large/)
  })

  it('rejects files past the total cap, so many small ones cannot substitute', () => {
    const oneMeg = 1024 * 1024
    const many = Array.from({ length: 40 }, () => file({ bytes: new Uint8Array(oneMeg) }))
    const plan = planAttachments(many, 'a-post', paths)

    const acceptedBytes = plan.accepted.reduce((sum, a) => sum + a.bytes.length, 0)
    expect(acceptedBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES)
    expect(plan.rejected.some((r) => /total/.test(r.reason))).toBe(true)
  })
})

describe('planAttachments — naming', () => {
  it('names files from the slug, not from the sender', () => {
    // An emailed filename is attacker-controlled and, in a flat shared assets
    // directory, very likely to collide — IMG_0001.jpg especially.
    const plan = planAttachments([file(), file({ filename: 'IMG_1235.png', mimeType: 'image/png' })], 'my-post', paths)
    expect(plan.accepted.map((a) => a.path)).toEqual([
      'public/static/images/my-post-1.jpg',
      'public/static/images/my-post-2.png',
    ])
  })

  it('gives the url the site serves, not the repo path', () => {
    const plan = planAttachments([file()], 'my-post', paths)
    expect(plan.accepted[0]!.url).toBe('/static/images/my-post-1.jpg')
  })

  it('takes the extension from the mime type, not the claimed filename', () => {
    const plan = planAttachments(
      [file({ filename: 'actually-a-png.jpg', mimeType: 'image/png' })],
      'my-post',
      paths,
    )
    expect(plan.accepted[0]!.path).toMatch(/\.png$/)
  })

  it('ignores path separators in a sender-supplied filename', () => {
    const plan = planAttachments(
      [file({ filename: '../../../etc/passwd.jpg' })],
      'my-post',
      paths,
    )
    expect(plan.accepted[0]!.path).toBe('public/static/images/my-post-1.jpg')
  })

  it('continues numbering from an offset, for attachments added later', () => {
    // A reply that appends more media must not overwrite what already landed.
    const plan = planAttachments([file()], 'my-post', paths, { startIndex: 3 })
    expect(plan.accepted[0]!.path).toBe('public/static/images/my-post-3.jpg')
  })

  it('keeps the original filename, for matching mentions in the body', () => {
    expect(planAttachments([file()], 'my-post', paths).accepted[0]!.originalFilename).toBe('IMG_1234.jpg')
  })
})

describe('placeAttachments', () => {
  const plan = (attachments: InboundAttachment[], slug = 'my-post') =>
    planAttachments(attachments, slug, paths).accepted

  it('leaves the body alone when there are no attachments', () => {
    expect(placeAttachments('The body.', [])).toEqual({ body: 'The body.', inlined: 0 })
  })

  it('replaces a mentioned filename with the image, in place', () => {
    const result = placeAttachments('Look at IMG_1234.jpg here.', plan([file()]))
    expect(result.body).toBe('Look at ![IMG_1234](/static/images/my-post-1.jpg) here.')
    expect(result.inlined).toBe(1)
  })

  it('matches a mention case-insensitively', () => {
    const result = placeAttachments('See img_1234.JPG', plan([file()]))
    expect(result.body).toContain('![IMG_1234](/static/images/my-post-1.jpg)')
  })

  it('appends an unmentioned image under a heading', () => {
    const result = placeAttachments('A post with no mention.', plan([file()]))
    expect(result.body).toContain('## Image')
    expect(result.body).toContain('![IMG_1234](/static/images/my-post-1.jpg)')
    expect(result.inlined).toBe(0)
  })

  it('pluralises the heading for several images', () => {
    const result = placeAttachments(
      'No mentions.',
      plan([file(), file({ filename: 'b.png', mimeType: 'image/png' })]),
    )
    expect(result.body).toContain('## Images')
  })

  it('always appends a document as a link, even when mentioned', () => {
    // Replacing "see report.pdf" with a bare link reads worse than a sentence
    // followed by one.
    const accepted = plan([file({ filename: 'report.pdf', mimeType: 'application/pdf' })])
    const result = placeAttachments('Details in report.pdf below.', accepted)
    expect(result.body).toContain('Details in report.pdf below.')
    expect(result.body).toContain('## Attachment')
    expect(result.body).toContain('- [report.pdf](/static/images/my-post-1.pdf)')
  })

  it('separates images from documents when both are appended', () => {
    const accepted = plan([file(), file({ filename: 'r.pdf', mimeType: 'application/pdf' })])
    const result = placeAttachments('No mentions.', accepted)
    expect(result.body.indexOf('## Image')).toBeLessThan(result.body.indexOf('## Attachment'))
  })

  it('does not match a filename inside a code span', () => {
    const body = 'Run `convert IMG_1234.jpg out.png` first.'
    const result = placeAttachments(body, plan([file()]))
    expect(result.body).toContain('`convert IMG_1234.jpg out.png`')
    expect(result.inlined).toBe(0)
    // ...and it is appended instead, so the image is not lost.
    expect(result.body).toContain('## Image')
  })

  it('does not match a filename inside a fenced block', () => {
    const body = '```\nIMG_1234.jpg\n```'
    const result = placeAttachments(body, plan([file()]))
    expect(result.inlined).toBe(0)
  })

  it('handles a mention and an unmentioned file in one message', () => {
    const accepted = plan([file(), file({ filename: 'other.png', mimeType: 'image/png' })])
    const result = placeAttachments('Only IMG_1234.jpg is mentioned.', accepted)
    expect(result.inlined).toBe(1)
    expect(result.body).toContain('![IMG_1234](/static/images/my-post-1.jpg)')
    expect(result.body).toContain('## Image')
  })
})
