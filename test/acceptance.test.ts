import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { emailToPost } from '../src/core/emailToPost.ts'
import { renderPost } from '../src/core/markdown.ts'

/**
 * The canonical acceptance test.
 *
 * `examples/acceptance-test/body.md` is a post exercising every markdown
 * feature the site supports. `expected.mdx` is exactly what the pipeline
 * should turn it into. If a change to the transformation alters the output,
 * this fails with a diff naming the construct that moved — which is a far
 * better signal than a Vercel build error pointing at a missing contentlayer
 * artifact.
 *
 * To accept an intended change, regenerate the fixture:
 *
 *     pnpm test:accept
 *
 * ...then read the diff before committing it. The end-to-end version of this
 * test — mail the body, get a building PR — is documented in
 * `examples/acceptance-test/README.md`.
 */

const dir = fileURLToPath(new URL('../examples/acceptance-test/', import.meta.url))

/** Fixed inputs, so the fixture is byte-stable across runs. */
export const FIXTURE_REQUEST = {
  title: 'Markdown Acceptance Test',
  date: new Date('2026-01-15T12:00:00Z'),
  author: 'you@example.com',
} as const

export function renderFixture(): string {
  const body = readFileSync(`${dir}body.md`, 'utf8')
  return renderPost({ ...FIXTURE_REQUEST, body })
}

describe('the canonical acceptance test', () => {
  it('turns the sample body into exactly the expected post', async () => {
    expect(renderFixture()).toBe(readFileSync(`${dir}expected.mdx`, 'utf8'))
  })

  it('produces frontmatter the site can parse', async () => {
    const output = renderFixture()
    expect(output.startsWith('---\n')).toBe(true)
    expect(output).toContain("title: 'Markdown Acceptance Test'")
    expect(output).toContain("date: '2026-01-15'")
    expect(output).toContain('draft: false')
  })

  it('preserves every construct that MDX would otherwise mangle', async () => {
    const output = renderFixture()

    // Math: braces inside TeX must survive unescaped, or KaTeX renders
    // visible backslashes.
    expect(output).toContain('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')
    expect(output).toContain('$E = mc^2$')

    // A reference-link definition must stay bare, or every reference breaks.
    expect(output).toMatch(/^\[ref\]: https:\/\/example\.com$/m)

    // Code is never rewritten, inside fences or backticks.
    expect(output).toContain('`if (x < 5) { go() }`')
    expect(output).toContain('5 < 10 && {braces} stay literal here.')

    // GFM, alerts and code titles pass through.
    expect(output).toContain('> [!NOTE]')
    expect(output).toContain('```js:wrangler.config.js')
    expect(output).toContain('- [x] A checked task')
    expect(output).toMatch(/^\[\^1\]: The first footnote\.$/m)
  })

  it('escapes prose that MDX would read as syntax', async () => {
    const output = renderFixture()
    expect(output).toContain('5 \\< 10')
    expect(output).toContain('Array\\<int>')
    expect(output).toContain('the \\{maybe\\} case')
  })

  it('converts autolinks, which are valid markdown but invalid MDX', async () => {
    const output = renderFixture()
    expect(output).toContain('[https://jennyweis.com](https://jennyweis.com)')
    expect(output).toContain('[nick@example.com](mailto:nick@example.com)')
    // No angle-bracket autolink may survive outside code.
    expect(output).not.toMatch(/[^`]<https?:\/\//)
  })
})

describe('the documented rejection cases', () => {
  // `examples/acceptance-test/rejections/` tells a reader what bounce to
  // expect. Documentation that has drifted from the code is worse than none,
  // because someone will trust it while debugging — so the exact text a
  // sender sees is asserted against what the docs promise.
  const htmlOnlyDoc = readFileSync(`${dir}rejections/html-only.md`, 'utf8')

  it('quotes the real sender message for an html-only rejection', async () => {
    const result = await emailToPost(
      {
        envelopeFrom: 'a@example.com',
        subject: 'A Post',
        authenticationResults: 'spf=pass; dkim=pass; dmarc=pass',
        text: null,
        date: new Date('2026-01-15T12:00:00Z'),
      },
      { policy: { allowedSenders: ['a@example.com'], subjectToken: '' } },
    )

    expect(result).toMatchObject({ ok: false, kind: 'content' })
    if (result.ok || !result.senderMessage) throw new Error('expected a content rejection')

    // The doc wraps its quoted message across lines; compare on collapsed
    // whitespace so formatting is not what breaks this.
    const collapse = (text: string) => text.replace(/\s+/g, ' ')
    expect(collapse(htmlOnlyDoc)).toContain(collapse(result.senderMessage))
  })

  it('lists every case the rejections README claims to cover', async () => {
    const readme = readFileSync(`${dir}rejections/README.md`, 'utf8')
    for (const claim of ['html-only', 'Not allowlisted', 'Wrong subject token', 'No title']) {
      expect(readme).toContain(claim)
    }
  })
})
