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
