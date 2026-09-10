# Rejection cases

The happy path is one email. These are the ways a message is *turned away*, and
what the sender should see when it happens.

They matter because a bounce is the only feedback a sender gets. A rejection
that says nothing useful is indistinguishable from the system being broken.

## The rule these cases check

| Failure | What the sender is told |
|---|---|
| Authentication | Nothing — a bare `Message rejected` |
| Anything after authentication | What was wrong, specifically |

Authentication failures stay silent on purpose: naming the check that failed
tells someone probing the system whether an address is allowlisted, or whether
a guessed token was close. Once a sender has cleared the allowlist and DKIM,
there is nobody left to withhold from, and they need to know what to fix.

The real reason for *every* rejection is in the Worker logs. Start
`npx wrangler tail` **before** sending — it shows live traffic only.

## Cases

| Case | Send | Expect |
|---|---|---|
| [`html-only.md`](html-only.md) | A message with no plain-text part | A bounce naming plain text |
| Not allowlisted | From an address not in `<SITE>_ALLOWED_SENDERS` | A bare `Message rejected` |
| Wrong subject token | `Subject: A Post [not-the-token]` | A bare `Message rejected` |
| No title | `Subject: [your-token]` and nothing else | A bounce about the title |
| Body is only metadata | A body of just `Tags: Testing` | A bounce about the body |

The two authentication cases are the ones worth checking most carefully: if
either ever starts explaining itself, that is a regression worth fixing, and
`test/emailToPost.test.ts` asserts it does not.

## What is covered offline

`pnpm test` asserts the classification and the exact sender-facing text for
every case above, so these emails are not the primary defence — they confirm
that Cloudflare actually delivers the rejection text to the sending server,
which no unit test can tell you.
