import { describe, expect, it } from 'vitest'
import { formatDate, linkifyBareUrls, renderPost, slugify } from '../src/core/markdown.ts'

describe('slugify', () => {
  it('matches the naming style of existing posts', () => {
    expect(slugify('LEGO IKEA Hack')).toBe('lego-ikea-hack')
    expect(slugify('Long time no see…')).toBe('long-time-no-see')
    expect(slugify('The 15-Minute iOS Project')).toBe('the-15-minute-ios-project')
  })

  it('drops apostrophes rather than turning them into hyphens', () => {
    expect(slugify("My Mother's Passing")).toBe('my-mothers-passing')
    expect(slugify('My Mother’s Passing')).toBe('my-mothers-passing')
  })

  it('reduces accented characters to ascii', () => {
    expect(slugify('Café Culture')).toBe('cafe-culture')
  })

  it('rejects a title with no usable characters', () => {
    expect(() => slugify('!!!')).toThrow(/empty slug/)
  })
})

describe('formatDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(formatDate(new Date('2025-07-13T18:30:00Z'))).toBe('2025-07-13')
  })

  it('rejects an invalid date', () => {
    expect(() => formatDate(new Date('nope'))).toThrow(/Invalid date/)
  })
})

describe('linkifyBareUrls', () => {
  it('wraps a bare url', () => {
    expect(linkifyBareUrls('See https://example.com for more')).toBe(
      'See [https://example.com](https://example.com) for more',
    )
  })

  it('leaves existing markdown links alone', () => {
    const input = 'See [the docs](https://example.com/docs) for more'
    expect(linkifyBareUrls(input)).toBe(input)
  })

  it('leaves angle-bracket autolinks alone', () => {
    const input = 'See <https://example.com> for more'
    expect(linkifyBareUrls(input)).toBe(input)
  })

  it('leaves urls inside inline and fenced code alone', () => {
    const inline = 'Run `curl https://example.com` first'
    expect(linkifyBareUrls(inline)).toBe(inline)

    const fenced = '```\ncurl https://example.com\n```'
    expect(linkifyBareUrls(fenced)).toBe(fenced)
  })

  it('does not swallow trailing sentence punctuation', () => {
    expect(linkifyBareUrls('Go to https://example.com.')).toBe(
      'Go to [https://example.com](https://example.com).',
    )
  })

  it('does not rewrite a reference-link definition', () => {
    // `[ref]: https://…` must stay bare; wrapping it breaks every reference
    // that points at it.
    const input = 'See [the docs][ref].\n\n[ref]: https://example.com'
    expect(linkifyBareUrls(input)).toBe(input)
  })

  it('leaves the image url in a markdown image alone', () => {
    const input = '![alt](https://example.com/a.png)'
    expect(linkifyBareUrls(input)).toBe(input)
  })
})

describe('renderPost', () => {
  const base = {
    title: 'Hello World',
    body: 'This is the body.',
    date: new Date('2026-09-09T12:00:00Z'),
    author: 'nick@example.com',
  }

  it('always marks the post as a draft', () => {
    expect(renderPost(base)).toContain('draft: true')
  })

  it('emits frontmatter in the style the blog already uses', () => {
    const output = renderPost({ ...base, tags: ['Personal'], summary: 'A summary.' })
    expect(output).toBe(
      [
        '---',
        "title: 'Hello World'",
        "date: '2026-09-09'",
        "tags: ['Personal']",
        'draft: true',
        "summary: 'A summary.'",
        '---',
        '',
        'This is the body.',
        '',
      ].join('\n'),
    )
  })

  it('escapes single quotes the way yaml requires', () => {
    const output = renderPost({ ...base, title: "Nick's Post" })
    expect(output).toContain("title: 'Nick''s Post'")
  })

  it('omits authors unless a real author file was resolved', () => {
    expect(renderPost(base)).not.toContain('authors:')
    expect(renderPost({ ...base, authorFile: 'default' })).toContain("authors: ['default']")
  })

  it('emits an empty tags array when none were given', () => {
    expect(renderPost(base)).toContain('tags: []')
  })
})
