import { describe, expect, it } from 'vitest'
import { isReservedFieldName, resolveExtraFields } from '../src/core/extraFields.ts'
import { parseHeaders } from '../src/core/headers.ts'
import { renderPost } from '../src/core/markdown.ts'
import { validateSites } from '../src/core/sites.ts'

const section = {
  type: 'enum' as const,
  values: { howto: ['how-to', 'tutorial'], opinion: ['editorial'], notes: [] },
}
const definitions = { section, series: { type: 'string' as const } }

describe('resolveExtraFields', () => {
  it('accepts the stored value, whatever the capitalisation', () => {
    for (const spelling of ['howto', 'HowTo', 'HOWTO']) {
      const result = resolveExtraFields({ section: spelling }, definitions)
      expect(result.ok && result.values.section, spelling).toBe('howto')
    }
  })

  it('accepts a label a reader would type, and stores the schema value', () => {
    // A site may head the page "Tutorial" while storing `howto`, so someone
    // writing an email reasonably types the label.
    expect(resolveExtraFields({ section: 'Tutorial' }, definitions)).toEqual({
      ok: true,
      values: { section: 'howto' },
    })
  })

  it('keeps a string field exactly as written', () => {
    expect(resolveExtraFields({ series: 'shipping-a-thing' }, definitions)).toEqual({
      ok: true,
      values: { series: 'shipping-a-thing' },
    })
  })

  it('rejects an unknown value and names what is accepted', () => {
    const result = resolveExtraFields({ section: 'Tootorial' }, definitions)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.message).toContain('Tootorial')
    expect(result.errors[0]!.message).toContain('opinion (or editorial)')
    // A value with no aliases is listed plainly rather than as "fun (or )".
    expect(result.errors[0]!.message).toContain('notes')
    expect(result.errors[0]!.message).not.toContain('notes (or )')
  })

  it('reports every bad field, not just the first', () => {
    // Otherwise a sender fixes one and discovers the next on the next attempt.
    const two = { section: { ...section }, mood: { type: 'enum' as const, values: { calm: [] } } }
    const result = resolveExtraFields({ section: 'nope', mood: 'also-nope' }, two)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((item) => item.field).sort()).toEqual(['mood', 'section'])
  })

  it('treats an empty value as unset rather than invalid', () => {
    // `Section:` with nothing after it is a sender trailing off, not an error.
    expect(resolveExtraFields({ section: '   ' }, definitions)).toEqual({ ok: true, values: {} })
  })

  it('ignores a field the site did not declare', () => {
    expect(resolveExtraFields({ nonsense: 'x' }, definitions)).toEqual({ ok: true, values: {} })
  })

  it('accepts nothing when a site declares nothing', () => {
    expect(resolveExtraFields({ section: 'build' }, undefined)).toEqual({ ok: true, values: {} })
  })

  it('knows which names every post already has', () => {
    for (const name of ['title', 'date', 'tags', 'draft', 'summary', 'authors', 'Title']) {
      expect(isReservedFieldName(name), name).toBe(true)
    }
    expect(isReservedFieldName('section')).toBe(false)
  })
})

describe('the header block with declared fields', () => {
  const body = 'Tags: Coding\nSummary: A summary.\nSection: Tutorial\nSeries: building-a-cli\n\nThe post body.'

  it('reads declared fields, under the name the site declared', () => {
    // The sender wrote `Section:`; the site declared `section`.
    const parsed = parseHeaders(body, ['section', 'series'])
    expect(parsed.extra).toEqual({ section: 'Tutorial', series: 'building-a-cli' })
    expect(parsed.body).toBe('The post body.')
    expect(parsed.tags).toEqual(['Coding'])
  })

  it('leaves an undeclared key as prose, exactly as before', () => {
    // This is what the other two sites see, and must not change.
    const parsed = parseHeaders(body)
    expect(parsed.extra).toBeUndefined()
    expect(parsed.body).toBe('Section: Tutorial\nSeries: building-a-cli\n\nThe post body.')
    expect(parsed.summary).toBe('A summary.')
  })

  it('still ends the block at the first unrecognised key', () => {
    const parsed = parseHeaders('Tags: A\nNonsense: x\nSection: notes\n\nBody.', ['section'])
    expect(parsed.extra).toBeUndefined()
    expect(parsed.body).toBe('Nonsense: x\nSection: notes\n\nBody.')
  })
})

describe('rendering declared frontmatter', () => {
  const base = {
    title: 'A Post',
    body: 'Body.',
    date: new Date('2026-09-27T12:00:00Z'),
    author: 'someone@example.com',
  }

  it('emits declared fields after the built-in keys, in the same style', () => {
    const out = renderPost({
      ...base,
      tags: ['Coding'],
      extraFrontmatter: { layout: 'WideLayout', section: 'howto' },
    })
    expect(out).toContain("layout: 'WideLayout'")
    expect(out).toContain("section: 'howto'")
    expect(out.indexOf('draft:')).toBeLessThan(out.indexOf('section:'))
  })

  it('emits nothing extra when a site declares nothing', () => {
    const out = renderPost({ ...base, tags: [] })
    expect(out.split('---')[1]).toBe(
      "\ntitle: 'A Post'\ndate: '2026-09-27'\ntags: []\ndraft: false\n",
    )
  })

  it('escapes a value the same way every other string is escaped', () => {
    const out = renderPost({ ...base, tags: [], extraFrontmatter: { series: "Nick's Series" } })
    expect(out).toContain("series: 'Nick''s Series'")
  })
})

describe('validating a site declaration', () => {
  const site = {
    key: 'example',
    inboundAddresses: ['posts@example.com'],
    owner: 'example',
    repo: 'example-blog',
    baseBranch: 'main',
    contentPath: 'data/blog',
    extension: '.mdx',
    authorsBySender: { 'someone@example.com': 'default' },
  }
  const check = (extra: Record<string, unknown>) => () =>
    validateSites({ sites: [{ ...site, ...extra }] } as never)

  it('accepts a well-formed declaration', () => {
    expect(check({ extraFields: definitions, frontmatter: { layout: 'WideLayout' }, summaryMinLength: 100 })).not.toThrow()
  })

  it('refuses to redeclare a field every post already has', () => {
    // Two `date:` lines is valid YAML where the second silently wins — a post
    // with the wrong date rather than an error.
    expect(check({ extraFields: { title: { type: 'string' } } })).toThrow(/cannot redeclare/)
    expect(check({ frontmatter: { date: '2020-01-01' } })).toThrow(/cannot set/)
  })

  it('refuses an alias that maps to two different values', () => {
    // Which one wins would depend on key order.
    expect(
      check({ extraFields: { p: { type: 'enum', values: { howto: ['x'], notes: ['X'] } } } }),
    ).toThrow(/both howto and notes/)
  })

  it('refuses an enum that accepts nothing, and an unknown type', () => {
    expect(check({ extraFields: { p: { type: 'enum', values: {} } } })).toThrow(/no values/)
    expect(check({ extraFields: { p: { type: 'number' } } })).toThrow(/unknown type/)
  })

  it('refuses a nonsense summary minimum', () => {
    expect(check({ summaryMinLength: 0 })).toThrow(/positive whole number/)
  })
})
