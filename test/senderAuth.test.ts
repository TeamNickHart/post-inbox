import { describe, expect, it } from 'vitest'
import {
  authenticateSender,
  extractSubjectToken,
  parseAuthenticationResults,
} from '../src/core/senderAuth.ts'

const policy = {
  allowedSenders: ['nick@example.com'],
  subjectToken: 's3cret-token',
}

const passingAuth = 'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass; dmarc=pass'

function input(overrides: Partial<Parameters<typeof authenticateSender>[0]> = {}) {
  return {
    envelopeFrom: 'nick@example.com',
    authenticationResults: passingAuth,
    subject: 'My Post [s3cret-token]',
    ...overrides,
  }
}

describe('parseAuthenticationResults', () => {
  it('reads pass verdicts', () => {
    expect(parseAuthenticationResults(passingAuth)).toEqual({
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
    })
  })

  it('treats a missing header as no verdicts at all', () => {
    expect(parseAuthenticationResults(null)).toEqual({ spf: 'none', dkim: 'none', dmarc: 'none' })
  })

  it('treats softfail and friends as failures, not passes', () => {
    const parsed = parseAuthenticationResults('spf=softfail; dkim=permerror; dmarc=fail')
    expect(parsed).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail' })
  })

  it('reads the arc=none header cloudflare currently sends as no verdicts', () => {
    expect(parseAuthenticationResults('i=1; mx.cloudflare.net; arc=none')).toEqual({
      spf: 'none',
      dkim: 'none',
      dmarc: 'none',
    })
  })
})

describe('extractSubjectToken', () => {
  it('pulls the token out and leaves a clean title', () => {
    expect(extractSubjectToken('My Post [s3cret]')).toEqual({ token: 's3cret', title: 'My Post' })
  })

  it('handles a token at the start', () => {
    expect(extractSubjectToken('[s3cret] My Post')).toEqual({ token: 's3cret', title: 'My Post' })
  })

  it('reports no token when the subject has none', () => {
    expect(extractSubjectToken('My Post')).toEqual({ token: null, title: 'My Post' })
  })
})

describe('authenticateSender', () => {
  it('accepts an allowlisted, authenticated sender with the right token', () => {
    const result = authenticateSender(input(), policy)
    expect(result.ok).toBe(true)
  })

  it('is case-insensitive about the sender address', () => {
    expect(authenticateSender(input({ envelopeFrom: 'Nick@Example.COM' }), policy).ok).toBe(true)
  })

  it('rejects a sender that is not allowlisted', () => {
    const result = authenticateSender(input({ envelopeFrom: 'attacker@evil.com' }), policy)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects a correct sender with the wrong token', () => {
    const result = authenticateSender(input({ subject: 'My Post [wrong-token]' }), policy)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects a correct sender with no token at all', () => {
    expect(authenticateSender(input({ subject: 'My Post' }), policy).ok).toBe(false)
  })

  it('fails closed when authentication results are absent', () => {
    const result = authenticateSender(input({ authenticationResults: null }), policy)
    expect(result).toMatchObject({ ok: false })
  })

  it('fails closed on the arc=none header cloudflare currently sends', () => {
    const result = authenticateSender(
      input({ authenticationResults: null, arcAuthenticationResults: 'i=1; arc=none' }),
      policy,
    )
    expect(result).toMatchObject({ ok: false })
  })

  it('accepts dkim pass even when spf fails, which is normal for forwarded mail', () => {
    const result = authenticateSender(
      input({ authenticationResults: 'spf=fail; dkim=pass; dmarc=pass' }),
      policy,
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a dmarc failure even with a passing dkim', () => {
    const result = authenticateSender(
      input({ authenticationResults: 'spf=pass; dkim=pass; dmarc=fail' }),
      policy,
    )
    expect(result).toMatchObject({ ok: false })
  })

  it('still requires the subject token when auth results are not required', () => {
    const relaxed = { ...policy, requireAuthResults: false }
    expect(authenticateSender(input({ authenticationResults: null }), relaxed).ok).toBe(true)
    expect(
      authenticateSender(input({ authenticationResults: null, subject: 'No token' }), relaxed).ok,
    ).toBe(false)
  })

  it('rejects everything when no subject token is configured', () => {
    const result = authenticateSender(input(), { ...policy, subjectToken: '' })
    expect(result).toMatchObject({ ok: false })
  })
})
