/**
 * Email the author that their draft post has a working preview.
 *
 * Copy into a blog repo as `.github/scripts/notify-author.mjs`.
 *
 * Deliberately dependency-free: it runs on a GitHub runner with no install
 * step, so it uses `fetch` against the Resend API directly rather than pulling
 * in the SDK. One less thing to keep current, and no supply-chain surface on a
 * job that handles a credential and an email address.
 *
 * Nothing here prints an address. A masked form goes to the log so a failure is
 * diagnosable; the real value never appears, because Actions logs outlive the
 * run and are readable by anyone with repo access.
 */

const {
  RESEND_API_KEY,
  AUTHOR_EMAIL_MAP,
  MAIL_FROM,
  AUTHOR,
  TITLE,
  POST_PATH,
  POST_SLUG,
  PREVIEW_URL,
  REF,
  GITHUB_REPOSITORY,
  GITHUB_SERVER_URL = 'https://github.com',
} = process.env

/** Obscure an address for logging: first letter, then the domain. */
const mask = (address) => address.replace(/^(.).*(@.*)$/, '$1***$2')

function fail(message) {
  console.error(`Not sending: ${message}`)
  // A missing notification must not fail the build. The post is already
  // committed and the preview already built; this step is a courtesy.
  process.exit(0)
}

if (!RESEND_API_KEY) fail('RESEND_API_KEY is not set')
if (!MAIL_FROM) fail('the NOTIFY_FROM variable is not set')
if (!AUTHOR) fail('the post has no `authors` entry, so there is no one to notify')

let map
try {
  map = JSON.parse(AUTHOR_EMAIL_MAP ?? '{}')
} catch {
  fail('AUTHOR_EMAIL_MAP is not valid JSON')
}

const recipient = map[AUTHOR]
if (!recipient) fail(`no address mapped for author "${AUTHOR}"`)

const prUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/pulls`

// Link the post itself, not the preview's homepage. A new post is not
// necessarily on the front page, so a bare preview link leaves the author
// looking for their own writing. Falls back to the homepage if the slug is
// somehow missing, since a working link beats no link.
const postUrl =
  POST_SLUG && PREVIEW_URL ? `${PREVIEW_URL.replace(/\/+$/, '')}/blog/${POST_SLUG}` : PREVIEW_URL
const lines = [
  `Your draft post is ready to look at.`,
  ``,
  `    ${TITLE}`,
  ``,
  `Read it:  ${postUrl}`,
  `Pull request: ${prUrl}`,
  ``,
  `Nothing is published yet. Read it through on the preview, and merge the pull`,
  `request when you are happy with it.`,
  ``,
  `If something looks wrong, reply to the email you sent — or edit ${POST_PATH}`,
  `directly in the pull request.`,
]

const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${RESEND_API_KEY}`,
    'Content-Type': 'application/json',
    // Keyed to the branch, so a re-run or a second deployment status for the
    // same post does not send a duplicate within Resend's 24-hour window.
    'Idempotency-Key': `post-inbox:${GITHUB_REPOSITORY}:${REF}`,
  },
  body: JSON.stringify({
    from: MAIL_FROM,
    to: recipient,
    subject: `Your post is ready to preview: ${TITLE}`,
    text: lines.join('\n'),
  }),
})

if (!response.ok) {
  // Resend's message names the cause — most often an unverified `from` domain.
  console.error(`Resend returned ${response.status}: ${await response.text()}`)
  process.exit(0)
}

const { id } = await response.json()
console.log(`Notified ${AUTHOR} (${mask(recipient)}) — Resend id ${id}`)
