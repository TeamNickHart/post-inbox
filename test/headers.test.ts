import { describe, expect, it } from 'vitest'
import { parseHeaders } from '../src/core/headers.ts'

describe('parseHeaders', () => {
  it('reads a tags line and removes it from the body', () => {
    expect(parseHeaders('Tags: Coding, iOS\n\nThe body.')).toEqual({
      tags: ['Coding', 'iOS'],
      body: 'The body.',
    })
  })

  it('reads a summary line', () => {
    expect(parseHeaders('Summary: What I learned.\n\nThe body.')).toEqual({
      summary: 'What I learned.',
      body: 'The body.',
    })
  })

  it('reads both, in either order', () => {
    const expected = { tags: ['AI'], summary: 'A summary.', body: 'Body.' }
    expect(parseHeaders('Tags: AI\nSummary: A summary.\n\nBody.')).toEqual(expected)
    expect(parseHeaders('Summary: A summary.\nTags: AI\n\nBody.')).toEqual(expected)
  })

  it('preserves tag case, matching the tags the site already uses', () => {
    // Real tags from the blog: IKEA, SwiftLint, iOS. Lowercasing would both
    // change their meaning and fragment the tag list.
    expect(parseHeaders('Tags: IKEA, SwiftLint, iOS\n\nBody.').tags).toEqual([
      'IKEA',
      'SwiftLint',
      'iOS',
    ])
  })

  it('allows spaces inside a tag', () => {
    // `job application` and `no kings` are real tags on the site.
    expect(parseHeaders('Tags: job application, no kings\n\nBody.').tags).toEqual([
      'job application',
      'no kings',
    ])
  })

  it('is case-insensitive about the key itself', () => {
    expect(parseHeaders('tags: AI\n\nBody.').tags).toEqual(['AI'])
    expect(parseHeaders('TAGS: AI\n\nBody.').tags).toEqual(['AI'])
  })

  it('tolerates missing and extra whitespace around the colon', () => {
    expect(parseHeaders('Tags:AI,Coding\n\nBody.').tags).toEqual(['AI', 'Coding'])
    expect(parseHeaders('Tags   :   AI\n\nBody.').tags).toEqual(['AI'])
  })

  it('drops empty entries in a tag list', () => {
    expect(parseHeaders('Tags: AI, , Coding,\n\nBody.').tags).toEqual(['AI', 'Coding'])
  })

  it('de-duplicates tags differing only in case, keeping the first spelling', () => {
    expect(parseHeaders('Tags: iOS, ios, IOS\n\nBody.').tags).toEqual(['iOS'])
  })

  it('works without a blank line after the block', () => {
    expect(parseHeaders('Tags: AI\nThe body.')).toEqual({ tags: ['AI'], body: 'The body.' })
  })
})

describe('parseHeaders — what must not be treated as metadata', () => {
  it('ignores a body with no header block', () => {
    expect(parseHeaders('Just prose.\n\nMore prose.')).toEqual({
      body: 'Just prose.\n\nMore prose.',
    })
  })

  it('ignores prose that merely contains a colon', () => {
    const input = 'Note: this is prose, not a header.\n\nMore.'
    expect(parseHeaders(input)).toEqual({ body: input })
  })

  it('ignores a tags line that is not at the very start', () => {
    const input = 'A first paragraph.\n\nTags: AI\n\nMore.'
    expect(parseHeaders(input)).toEqual({ body: input })
  })

  it('stops at the first unrecognised key rather than dropping it', () => {
    // `Author:` is not supported; it stays as body text rather than
    // vanishing, and parsing stops there.
    const input = 'Author: Someone\nTags: AI\n\nBody.'
    expect(parseHeaders(input)).toEqual({ body: input })
  })

  it('stops at a repeated key rather than silently taking the last', () => {
    const result = parseHeaders('Tags: AI\nTags: Coding\n\nBody.')
    expect(result.tags).toEqual(['AI'])
    expect(result.body).toBe('Tags: Coding\n\nBody.')
  })

  it('does not treat a markdown heading as a header line', () => {
    const input = '## Heading\n\nBody.'
    expect(parseHeaders(input)).toEqual({ body: input })
  })

  it('leaves a url in the first line alone', () => {
    const input = 'https://example.com is worth reading.\n\nMore.'
    expect(parseHeaders(input)).toEqual({ body: input })
  })

  it('yields no tags when the line has no usable values', () => {
    const result = parseHeaders('Tags:\n\nBody.')
    expect(result.tags).toBeUndefined()
    expect(result.body).toBe('Body.')
  })
})
