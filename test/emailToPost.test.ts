import { describe, expect, it } from 'vitest'
import { emailToPost, type InboundEmail } from '../src/core/emailToPost.ts'

const policy = { allowedSenders: ['nickhart@gmail.com'], subjectToken: 'correct-token' }
const options = { policy }

/** A message that should be accepted, as a baseline to vary from. */
function genuine(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    envelopeFrom: 'nickhart@gmail.com',
    subject: 'A Real Post [correct-token]',
    authenticationResults:
      'mx.cloudflare.net; spf=pass smtp.mailfrom=gmail.com; dkim=pass header.d=gmail.com; dmarc=pass',
    text: 'The body.\n\n-- \nNick Hart\nnickhart@gmail.com\n',
    date: new Date('2026-09-09T12:00:00Z'),
    ...overrides,
  }
}

describe('emailToPost — the genuine case', () => {
  it('accepts an authenticated, allowlisted message and strips the signature', () => {
    const result = emailToPost(genuine(), options)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.title).toBe('A Real Post')
      expect(result.request.body).toBe('The body.')
      expect(result.request.author).toBe('nickhart@gmail.com')
    }
  })

  it('does not mark the post as a draft by default', () => {
    const result = emailToPost(genuine(), options)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.draft).toBe(false)
  })

  it('marks the post as a draft when configured to', () => {
    const result = emailToPost(genuine(), { ...options, draft: true })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.draft).toBe(true)
  })

  it('keeps the signature when stripping is turned off', () => {
    const result = emailToPost(genuine(), { ...options, stripSignature: false })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.body).toContain('Nick Hart')
  })
})

describe('emailToPost — metadata headers', () => {
  it('reads tags and summary from the top of the body', () => {
    const result = emailToPost(
      genuine({ text: 'Tags: Coding, iOS\nSummary: A summary.\n\nThe body.\n\n-- \nSig\n' }),
      options,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.request.tags).toEqual(['Coding', 'iOS'])
      expect(result.request.summary).toBe('A summary.')
      expect(result.request.body).toBe('The body.')
    }
  })

  it('leaves tags unset when the body has no header block', () => {
    const result = emailToPost(genuine(), options)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.tags).toBeUndefined()
  })

  it('rejects a message whose body is only a header block', () => {
    const result = emailToPost(genuine({ text: 'Tags: AI\n' }), options)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/header block/)
  })
})

describe('emailToPost — a forged sender', () => {
  // Every case below claims to be nickhart@gmail.com but carries no valid
  // subject token, because an attacker does not have it. What separates
  // them from a genuine message is the authentication verdicts, which are
  // precisely what cannot be faked.
  const noToken = { subject: 'Forged Post' }

  it('rejects the plain forgery: spf and dkim both fail', () => {
    const result = emailToPost(
      genuine({
        ...noToken,
        authenticationResults:
          'mx.cloudflare.net; spf=fail smtp.mailfrom=gmail.com; dkim=none; dmarc=fail header.from=gmail.com',
      }),
      options,
    )
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/no passing SPF or DKIM/)
  })

  it('rejects the subtler forgery: spf passes for the attacker relay, dmarc catches it', () => {
    // The attacker's own domain passes SPF, but they cannot produce a
    // gmail.com DKIM signature, so the header.from does not align.
    const result = emailToPost(
      genuine({
        ...noToken,
        authenticationResults:
          'mx.cloudflare.net; spf=pass smtp.mailfrom=attacker.example; dkim=none; dmarc=fail header.from=gmail.com',
      }),
      options,
    )
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/DMARC/)
  })

  it('rejects a message with no verdicts at all', () => {
    const result = emailToPost(genuine({ ...noToken, authenticationResults: null }), options)
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects the arc=none header cloudflare sometimes sends', () => {
    const result = emailToPost(
      genuine({
        ...noToken,
        authenticationResults: null,
        arcAuthenticationResults: 'i=1; mx.cloudflare.net; arc=none',
      }),
      options,
    )
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects softfail, which is not a pass', () => {
    const result = emailToPost(
      genuine({ ...noToken, authenticationResults: 'spf=softfail; dkim=none; dmarc=none' }),
      options,
    )
    expect(result).toMatchObject({ ok: false })
  })

  it('rejects a sender that is not on the allowlist even when fully authenticated', () => {
    const result = emailToPost(
      genuine({
        envelopeFrom: 'someone@else.example',
        authenticationResults: 'spf=pass; dkim=pass; dmarc=pass',
      }),
      options,
    )
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/not allowlisted/)
  })

  it('rejects a forgery that guesses at the token', () => {
    const result = emailToPost(
      genuine({
        subject: 'Forged Post [guessed-token]',
        authenticationResults: 'spf=fail; dkim=none; dmarc=fail',
      }),
      options,
    )
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/invalid subject token/)
  })

  it('accepts a genuine message with no token, since SPF/DKIM carried it', () => {
    // The rule the token requirement exists to serve: a properly
    // authenticated allowlisted sender does not need to type a secret.
    const result = emailToPost(genuine({ subject: 'A Real Post' }), options)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.title).toBe('A Real Post')
  })
})

describe('emailToPost — the REQUIRE_AUTH_RESULTS downgrade', () => {
  const relaxed = { policy: { ...policy, requireAuthResults: false } }

  it('lets a forgery through when it has the token, the documented cost', () => {
    // Recorded deliberately: with verdicts unchecked, the subject token is
    // the only thing standing between a forged sender and a draft PR.
    const result = emailToPost(
      genuine({ authenticationResults: 'spf=fail; dkim=none; dmarc=fail' }),
      relaxed,
    )
    expect(result.ok).toBe(true)
  })

  it('still blocks a forgery that lacks the subject token', () => {
    const result = emailToPost(
      genuine({ authenticationResults: 'spf=fail; dkim=none; dmarc=fail', subject: 'No token' }),
      relaxed,
    )
    expect(result).toMatchObject({ ok: false })
  })

  it('requires the token even from a genuine sender, since verdicts are off', () => {
    // Turning verdicts off removes the strong pair, so the token stops
    // being optional. The two protections cannot both be absent.
    const result = emailToPost(genuine({ subject: 'A Real Post' }), relaxed)
    expect(result).toMatchObject({ ok: false })
  })
})

describe('emailToPost — malformed messages', () => {
  it('rejects html-only mail, which has no plaintext body', () => {
    const result = emailToPost(genuine({ text: null }), options)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/no plaintext body/)
  })

  it('rejects a subject that is only a token', () => {
    const result = emailToPost(genuine({ subject: '[correct-token]' }), options)
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toMatch(/empty subject/)
  })

  it('falls back to the current time when the message has no date', () => {
    const now = new Date('2026-01-02T03:04:05Z')
    const result = emailToPost(genuine({ date: null }), { ...options, now: () => now })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.request.date).toEqual(now)
  })
})

describe('what a rejected sender is told', () => {
  // The security-relevant half of this: an authentication failure must not
  // explain itself. Naming the failed check tells someone probing the system
  // whether an address is allowlisted, or whether a guessed token was close.
  const authFailures: [string, InboundEmail][] = [
    ['sender not allowlisted', genuine({ envelopeFrom: 'stranger@example.com' })],
    ['wrong subject token', genuine({ subject: 'A Post [wrong-token]' })],
    [
      'no passing verdicts and no token',
      genuine({ subject: 'A Post', authenticationResults: 'spf=fail; dkim=none; dmarc=fail' }),
    ],
  ]

  for (const [label, email] of authFailures) {
    it(`says nothing to the sender about: ${label}`, () => {
      const result = emailToPost(email, options)
      expect(result).toMatchObject({ ok: false, kind: 'auth' })
      if (!result.ok) {
        expect(result.senderMessage).toBeUndefined()
        // The reason is still logged for us.
        expect(result.reason.length).toBeGreaterThan(0)
      }
    })
  }

  // Content failures happen only after authentication, so there is nobody left
  // to withhold information from — and the sender needs to know what to fix.
  it('tells an authenticated sender that html-only mail is unsupported', () => {
    const result = emailToPost(genuine({ text: null }), options)
    expect(result).toMatchObject({ ok: false, kind: 'content' })
    if (!result.ok) {
      expect(result.senderMessage).toMatch(/plain.text/i)
      expect(result.senderMessage).toMatch(/HTML/i)
    }
  })

  it('tells an authenticated sender the subject left no title', () => {
    const result = emailToPost(genuine({ subject: '[correct-token]' }), options)
    expect(result).toMatchObject({ ok: false, kind: 'content' })
    if (!result.ok) expect(result.senderMessage).toMatch(/title/i)
  })

  it('accepts a body that is only a signature block, rather than emptying it', () => {
    // `stripSignature` leaves such a body alone: a lone delimiter is more
    // likely a horizontal rule than an empty post. So this succeeds — the
    // "empty after stripping" branch is unreachable from a real message, and
    // exists as a guard rather than a case to report.
    const result = emailToPost(genuine({ text: '-- \nJust a sig\n' }), options)
    expect(result.ok).toBe(true)
  })

  it('tells an authenticated sender the body was only a header block', () => {
    const result = emailToPost(genuine({ text: 'Tags: AI\n' }), options)
    expect(result).toMatchObject({ ok: false, kind: 'content' })
    if (!result.ok) expect(result.senderMessage).toMatch(/body/i)
  })

  it('keeps every sender-facing message to a single short line', () => {
    // It travels through other people\'s mail software as an SMTP rejection,
    // where a long or multi-line reason may be truncated.
    const contentFailures = [
      genuine({ text: null }),
      genuine({ subject: '[correct-token]' }),
      genuine({ text: 'Tags: AI\n' }),
      genuine({ text: '   \n\n  \n' }),
    ]
    for (const email of contentFailures) {
      const result = emailToPost(email, options)
      if (!result.ok && result.senderMessage) {
        expect(result.senderMessage).not.toContain('\n')
        expect(result.senderMessage.length).toBeLessThan(160)
      }
    }
  })
})
