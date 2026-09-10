/**
 * Set the Worker's global secrets.
 *
 *     pnpm configure
 *
 * Global because they are not per-site: one GitHub credential writes to every
 * configured repo, and the subject token is a fallback that only engages when
 * SPF/DKIM cannot vouch for a message. Per-site secrets — the sender allowlist
 * and the HTTPS bearer token — are set by `pnpm configure:site <key>`.
 */
import {
  confirm,
  existingSecretNames,
  generateToken,
  promptSecret,
  putSecret,
} from './lib/secrets.mjs'

const TOKEN_HELP =
  'https://github.com/TeamNickHart/post-inbox#1-github-credentials'

const existing = existingSecretNames()

/** Ask before replacing a secret that is already set. */
async function shouldSet(name) {
  if (existing?.has(name)) {
    return await confirm(`  ${name} is already set. Replace it?`)
  }
  return true
}

console.log('\nGlobal secrets for the post-inbox Worker.\n')

// --- GITHUB_TOKEN: comes from GitHub, so it must be pasted. ---
if (await shouldSet('GITHUB_TOKEN')) {
  console.log('GITHUB_TOKEN — a fine-grained PAT, or a GitHub App installation token.')
  console.log('  Needs Contents: read/write and Pull requests: read/write on each blog repo.')
  console.log(`  Setting one up: ${TOKEN_HELP}\n`)

  const token = await promptSecret('  Paste the token (not echoed): ')
  if (!token) {
    console.error('  No token entered; skipped.\n')
  } else if (/\s/.test(token)) {
    console.error('  That value contains whitespace — a copied newline breaks it. Skipped.\n')
  } else if (putSecret('GITHUB_TOKEN', token)) {
    console.log('  Set GITHUB_TOKEN.\n')
  } else {
    console.error('  wrangler failed; see above.\n')
  }
} else {
  console.log('  Kept the existing GITHUB_TOKEN.\n')
}

// --- EMAIL_SUBJECT_TOKEN: optional, and we can generate it. ---
console.log('EMAIL_SUBJECT_TOKEN — optional fallback, written in a subject line as [token].')
console.log('  Only required when SPF/DKIM verdicts cannot vouch for a message.')
console.log('  Mail from a major provider normally carries passing verdicts, so most')
console.log('  setups do not need this at all.\n')

if (await confirm('  Set a subject token?')) {
  if (await shouldSet('EMAIL_SUBJECT_TOKEN')) {
    const token = generateToken()
    if (putSecret('EMAIL_SUBJECT_TOKEN', token)) {
      // Printed because you have to type it into a subject line. It is the one
      // generated secret that cannot stay hidden.
      console.log(`\n  Set EMAIL_SUBJECT_TOKEN. Put this in the subject as [token]:\n`)
      console.log(`    ${token}\n`)
      console.log('  Save it now — it cannot be read back from Cloudflare.\n')
    } else {
      console.error('  wrangler failed; see above.\n')
    }
  } else {
    console.log('  Kept the existing EMAIL_SUBJECT_TOKEN.\n')
  }
} else {
  console.log('  Skipped.\n')
}

console.log('Next: pnpm configure:site <key>   (once per site in sites.jsonc)')
console.log('Then: pnpm deploy\n')
