import { describe, expect, it } from 'vitest'
import { makeMdxSafe } from '../src/core/mdx.ts'

const safe = (input: string) => makeMdxSafe(input).text

describe('makeMdxSafe — the case that broke the site build', () => {
  it('converts a url autolink to a markdown link', () => {
    // `<https://…>` is valid markdown but invalid MDX: the parser reads `<`
    // as a JSX tag and fails on the `/`. This failed a real Vercel build.
    expect(safe('See <https://jennyweis.com> for more.')).toBe(
      'See [https://jennyweis.com](https://jennyweis.com) for more.',
    )
  })

  it('converts an email autolink to a mailto link', () => {
    expect(safe('Mail <nick@example.com> today.')).toBe(
      'Mail [nick@example.com](mailto:nick@example.com) today.',
    )
  })
})

describe('makeMdxSafe — escaping MDX syntax in prose', () => {
  it('escapes a `<` followed by a digit', () => {
    expect(safe('x <5 items')).toBe('x \\<5 items')
  })

  it('escapes a `<` followed by a letter, which MDX reads as a tag', () => {
    expect(safe('if x <y then')).toBe('if x \\<y then')
  })

  it('escapes tag-shaped prose', () => {
    expect(safe('An Array<int> value')).toBe('An Array\\<int> value')
  })

  it('escapes braces, which MDX reads as a javascript expression', () => {
    expect(safe('Costs {maybe} dollars')).toBe('Costs \\{maybe\\} dollars')
  })

  it('leaves `>` alone, since it is only meaningful after a `<`', () => {
    expect(safe('10 > 5 always')).toBe('10 > 5 always')
  })

  it('does not double-escape what the author already escaped', () => {
    expect(safe('Already \\< escaped')).toBe('Already \\< escaped')
  })

  it('escapes a `<` preceded by an escaped backslash', () => {
    // `\\<` is an escaped backslash followed by a live `<`, so the `<` still
    // needs escaping — an odd/even backslash count decides.
    expect(safe('A \\\\<b> tag')).toBe('A \\\\\\<b> tag')
  })
})

describe('makeMdxSafe — what must not be touched', () => {
  it('leaves fenced code blocks alone', () => {
    const input = '```js\nif (x < 5) { go() }\n```'
    expect(safe(input)).toBe(input)
  })

  it('leaves inline code alone', () => {
    const input = 'Run `<https://x.com>` and `{braces}` here'
    expect(safe(input)).toBe(input)
  })

  it('leaves existing markdown links alone', () => {
    const input = 'A [link](https://example.com) here'
    expect(safe(input)).toBe(input)
  })

  it('leaves ordinary prose completely untouched', () => {
    const input = [
      '# Heading',
      '',
      'Some **bold** and *italic* and ~~strike~~.',
      '',
      '- a list',
      '- [x] a task',
      '',
      '| col | val |',
      '|-----|-----|',
      '| a   | 1   |',
      '',
      'An em-dash — ellipsis… "quotes" café 日本語 🎉',
    ].join('\n')
    expect(safe(input)).toBe(input)
  })

  it('reports no changes when nothing needed escaping', () => {
    expect(makeMdxSafe('Just plain prose.').changes).toEqual([])
  })
})

describe('makeMdxSafe — reported changes', () => {
  it('describes what it altered, for the pull request body', () => {
    const { changes } = makeMdxSafe('See <https://x.com> and x <5 and {v}')
    expect(changes).toHaveLength(3)
    expect(changes.join(' ')).toMatch(/autolink/)
    expect(changes.join(' ')).toMatch(/`<`/)
    expect(changes.join(' ')).toMatch(/expression/)
  })

  it('does not repeat a change it made several times', () => {
    const { changes } = makeMdxSafe('x <1 y <2 z <3')
    expect(changes).toHaveLength(1)
  })
})

describe('makeMdxSafe — documented limitation', () => {
  it('escapes raw html rather than rendering it', () => {
    // Markdown permits `<b>bold</b>`; after this it renders as visible angle
    // brackets. A deliberate trade for email input — use `**bold**` instead.
    expect(safe('Some <b>bold</b> text')).toBe('Some \\<b>bold\\</b> text')
  })
})
