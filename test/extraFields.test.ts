import { describe, expect, it } from 'vitest'
import { isReservedFieldName, resolveExtraFields } from '../src/core/extraFields.ts'
import { parseHeaders } from '../src/core/headers.ts'
import { renderPost } from '../src/core/markdown.ts'
import { validateSites } from '../src/core/sites.ts'

const pillar = {
  type: 'enum' as const,
  values: { build: ['building'], leadership: ['leading'], fun: [] },
}
const definitions = { pillar, project: { type: 'string' as const } }

describe('resolveExtraFields', () => {
  it('accepts the stored value, whatever the capitalisation', () => {
    for (const spelling of ['build', 'Build', 'BUILD']) {
      const result = resolveExtraFields({ pillar: spelling }, definitions)
      expect(result.ok && result.values.pillar, spelling).toBe('build')
    }
  })

  it('accepts a label a reader would type, and stores the schema value', () => {
    // The site shows "Leading" on the badge but stores `leadership`, so someone
    // writing an email reasonably types the label.
    expect(resolveExtraFields({ pillar: 'Leading' }, definitions)).toEqual({
      ok: true,
      values: { pillar: 'leadership' },
    })
  })

  it('keeps a string field exactly as written', () => {
    expect(resolveExtraFields({ project: 'smart-hvac-guardian' }, definitions)).toEqual({
      ok: true,
      values: { project: 'smart-hvac-guardian' },
    })
  })

  it('rejects an unknown value and names what is accepted', () => {
    const result = resolveExtraFields({ pillar: 'Leeding' }, definitions)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]!.message).toContain('Leeding')
    expect(result.errors[0]!.message).toContain('leadership (or leading)')
    // A value with no aliases is listed plainly rather than as "fun (or )".
    expect(result.errors[0]!.message).toContain('fun')
    expect(result.errors[0]!.message).not.toContain('fun (or )')
  })

  it('reports every bad field, not just the first', () => {
    // Otherwise a sender fixes one and discovers the next on the next attempt.
    const two = { pillar: { ...pillar }, mood: { type: 'enum' as const, values: { calm: [] } } }
    const result = resolveExtraFields({ pillar: 'nope', mood: 'also-nope' }, two)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((item) => item.field).sort()).toEqual(['mood', 'pillar'])
  })

  it('treats an empty value as unset rather than invalid', () => {
    // `Pillar:` with nothing after it is a sender trailing off, not an error.
    expect(resolveExtraFields({ pillar: '   ' }, definitions)).toEqual({ ok: true, values: {} })
  })

  it('ignores a field the site did not declare', () => {
    expect(resolveExtraFields({ nonsense: 'x' }, definitions)).toEqual({ ok: true, values: {} })
  })

  it('accepts nothing when a site declares nothing', () => {
    expect(resolveExtraFields({ pillar: 'build' }, undefined)).toEqual({ ok: true, values: {} })
  })

  it('knows which names every post already has', () => {
    for (const name of ['title', 'date', 'tags', 'draft', 'summary', 'authors', 'Title']) {
      expect(isReservedFieldName(name), name).toBe(true)
    }
    expect(isReservedFieldName('pillar')).toBe(false)
  })
})

describe('the header block with declared fields', () => {
  const body = 'Tags: Coding\nSummary: A summary.\nPillar: Leading\nProject: md2do\n\nThe post body.'

  it('reads declared fields, under the name the site declared', () => {
    // The sender wrote `Pillar:`; the site declared `pillar`.
    const parsed = parseHeaders(body, ['pillar', 'project'])
    expect(parsed.extra).toEqual({ pillar: 'Leading', project: 'md2do' })
    expect(parsed.body).toBe('The post body.')
    expect(parsed.tags).toEqual(['Coding'])
  })

  it('leaves an undeclared key as prose, exactly as before', () => {
    // This is what the other two sites see, and must not change.
    const parsed = parseHeaders(body)
    expect(parsed.extra).toBeUndefined()
    expect(parsed.body).toBe('Pillar: Leading\nProject: md2do\n\nThe post body.')
    expect(parsed.summary).toBe('A summary.')
  })

  it('still ends the block at the first unrecognised key', () => {
    const parsed = parseHeaders('Tags: A\nNonsense: x\nPillar: fun\n\nBody.', ['pillar'])
    expect(parsed.extra).toBeUndefined()
    expect(parsed.body).toBe('Nonsense: x\nPillar: fun\n\nBody.')
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
      extraFrontmatter: { layout: 'PostBanner', pillar: 'leadership' },
    })
    expect(out).toContain("layout: 'PostBanner'")
    expect(out).toContain("pillar: 'leadership'")
    expect(out.indexOf('draft:')).toBeLessThan(out.indexOf('pillar:'))
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
    expect(check({ extraFields: definitions, frontmatter: { layout: 'PostBanner' }, summaryMinLength: 100 })).not.toThrow()
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
      check({ extraFields: { p: { type: 'enum', values: { build: ['x'], fun: ['X'] } } } }),
    ).toThrow(/both build and fun/)
  })

  it('refuses an enum that accepts nothing, and an unknown type', () => {
    expect(check({ extraFields: { p: { type: 'enum', values: {} } } })).toThrow(/no values/)
    expect(check({ extraFields: { p: { type: 'number' } } })).toThrow(/unknown type/)
  })

  it('refuses a nonsense summary minimum', () => {
    expect(check({ summaryMinLength: 0 })).toThrow(/positive whole number/)
  })
})
