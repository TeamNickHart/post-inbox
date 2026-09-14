import { describe, expect, it } from 'vitest'
import { stripSignature } from '../src/core/signature.ts'

describe('stripSignature', () => {
  it('strips the signature from a real message sent through the system', () => {
    // Byte-for-byte the body that landed in your-blog PR #8.
    const body = 'testing!!!\n\n-- \nNick Hart\nnickhart@gmail.com\n[http://nickhart.com](http://nickhart.com)\n'
    expect(stripSignature(body)).toBe('testing!!!')
  })

  it('leaves a body with no signature untouched', () => {
    const body = 'A post.\n\nWith two paragraphs.'
    expect(stripSignature(body)).toBe(body)
  })

  it('handles crlf line endings', () => {
    const body = 'Post body.\r\n\r\n-- \r\nSig line\r\n'
    expect(stripSignature(body)).toBe('Post body.')
  })

  it('cuts at the last delimiter, not the first', () => {
    const body = 'Intro.\n\n-- \n\nStill the post.\n\n-- \nThe real signature\n'
    expect(stripSignature(body)).toBe('Intro.\n\n-- \n\nStill the post.')
  })

  it('tolerates a delimiter whose trailing space was stripped in transit', () => {
    // Some clients and relays trim trailing whitespace, leaving bare `--`.
    const body = 'Post body.\n\n--\nSig line\n'
    expect(stripSignature(body)).toBe('Post body.')
  })

  it('does not touch a horizontal rule made of three or more hyphens', () => {
    expect(stripSignature('Above.\n\n---\n\nBelow.')).toBe('Above.\n\n---\n\nBelow.')
    expect(stripSignature('Above.\n\n----\n\nBelow.')).toBe('Above.\n\n----\n\nBelow.')
  })

  it('keeps a horizontal rule while still cutting a signature below it', () => {
    expect(stripSignature('A.\n\n---\n\nB.\n\n-- \nSig\n')).toBe('A.\n\n---\n\nB.')
  })

  it('does not touch an em-dash used as prose', () => {
    const body = 'A thought — then another.\n\nMore text.'
    expect(stripSignature(body)).toBe(body)
  })

  it('keeps the body when it consists only of a signature block', () => {
    // More likely a delimiter used as a rule than a genuinely empty post,
    // and returning empty would get the message rejected as bodyless.
    const body = '-- \nJust a signature\n'
    expect(stripSignature(body)).toBe(body)
  })

  it('preserves markdown structure above the signature', () => {
    const body = '## Heading\n\n- one\n- two\n\n```\ncode -- here\n```\n\n-- \nSig\n'
    expect(stripSignature(body)).toBe('## Heading\n\n- one\n- two\n\n```\ncode -- here\n```')
  })

  it('does not cut on a hyphen pair inside a line', () => {
    const body = 'Use the -- flag.\n\nMore text.'
    expect(stripSignature(body)).toBe(body)
  })
})

describe('signatures with no delimiter at all', () => {
  // iOS Gmail appends a signature as bare trailing lines with no `-- `, which
  // put a real name, address and URL into a post on a public repo. Catching it
  // needs a heuristic, so every rule below errs towards leaving text alone.

  it('strips the trailing contact block a real iOS Gmail message produced', () => {
    const body = '# heading\n\nSome real post content.\n\nNick Hart\nsomeone@example.com\n[http://example.com](http://example.com)'
    const out = stripSignature(body)
    expect(out).toBe('# heading\n\nSome real post content.')
    expect(out).not.toContain('@example.com')
  })

  it('strips a name and address, or either alone', () => {
    for (const block of ['Jenny Weis\nsomeone@example.com', 'someone@example.com', 'https://example.com', 'Nick\nwww.example.com']) {
      expect(stripSignature(`Post body.\n\n${block}`), block).toBe('Post body.')
    }
  })

  it('requires an address or URL, so a plain sign-off is left alone', () => {
    // A closing line with no contact details reads exactly like prose, so
    // guessing at it would eat real writing.
    const body = 'Post body.\n\nThanks,\nNick'
    expect(stripSignature(body)).toBe(body)
  })

  it('leaves prose that merely mentions an address', () => {
    const body = 'Post body.\n\nEmail me at someone@example.com if you want to talk about any of this.'
    expect(stripSignature(body)).toBe(body)
  })

  it('leaves a block carrying markdown structure', () => {
    for (const block of ['- see https://example.com\n- and more', '![alt](/static/images/a.jpg)', '> https://example.com', '```\nhttps://example.com\n```']) {
      expect(stripSignature(`Post body.\n\n${block}`), block).toBe(`Post body.\n\n${block}`)
    }
  })

  it('leaves a block introduced by a heading, which makes it content', () => {
    // A `## Links` section of bare URLs is a post, not a signature — and the
    // heading sits in the *previous* block, so it has to be looked for there.
    const body = 'Post body.\n\n## Links\n\nhttps://example.com'
    expect(stripSignature(body)).toBe(body)
  })

  it('still strips when a heading appears earlier in the post', () => {
    expect(stripSignature('## Section\n\nContent.\n\nNick\nsomeone@example.com')).toBe(
      '## Section\n\nContent.',
    )
  })

  it('leaves a body that is only a contact block', () => {
    // Nothing would remain, and an empty post is worse than a signature.
    const body = 'Nick Hart\nsomeone@example.com'
    expect(stripSignature(body)).toBe(body)
  })

  it('leaves a block that is too long or too wide to be contact details', () => {
    const tooMany = 'Post body.\n\nsomeone@example.com\nb\nc\nd\ne\nf'
    expect(stripSignature(tooMany)).toBe(tooMany)
    const tooWide = 'Post body.\n\nYou can reach me at someone@example.com or just leave a comment below instead.'
    expect(stripSignature(tooWide)).toBe(tooWide)
  })
})

describe('delimiter variants clients actually send', () => {
  it('accepts an indented delimiter', () => {
    expect(stripSignature('Post body.\n\n  -- \nNick')).toBe('Post body.')
  })

  it('accepts a non-breaking space after the hyphens', () => {
    // Some clients substitute one for the RFC's plain space.
    expect(stripSignature('Post body.\n\n--\u00a0\nNick')).toBe('Post body.')
    expect(stripSignature('Post body.\n\n--\u202f\nNick')).toBe('Post body.')
  })

  it('still leaves a markdown horizontal rule alone', () => {
    const body = 'Post body.\n\n---\n\nMore body.'
    expect(stripSignature(body)).toBe(body)
  })
})
