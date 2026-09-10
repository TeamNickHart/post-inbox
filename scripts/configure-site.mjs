/**
 * Set one site's secrets.
 *
 *     pnpm configure:site nickhart
 *
 * Per-site because these are what distinguish one site from another: who may
 * post to it, and the bearer token for its HTTPS endpoint. Global secrets are
 * set by `pnpm configure`.
 */
import {
  confirm,
  existingSecretNames,
  generateToken,
  looksLikeAddress,
  parseAddressList,
  prompt,
  promptSecret,
  putSecret,
  readSiteKeys,
  secretPrefix,
} from './lib/secrets.mjs'

const keys = readSiteKeys()
const requested = process.argv[2]

if (!requested) {
  console.error(`\nUsage: pnpm configure:site <key>\n\nConfigured sites: ${keys.join(', ')}\n`)
  process.exit(1)
}
if (!keys.includes(requested)) {
  console.error(`\nNo site "${requested}" in sites.jsonc.\n\nConfigured sites: ${keys.join(', ')}\n`)
  process.exit(1)
}

const prefix = secretPrefix(requested)
const existing = existingSecretNames()

async function shouldSet(name) {
  if (existing?.has(name)) return await confirm(`  ${name} is already set. Replace it?`)
  return true
}

console.log(`\nSecrets for site "${requested}" (prefix ${prefix}).\n`)

// --- Sender allowlist: required, and not secret in the usual sense, but it
// --- names real people's addresses so it stays out of git.
const sendersName = `${prefix}_ALLOWED_SENDERS`
console.log(`${sendersName} — envelope addresses allowed to post to this site.`)
console.log('  Several are fine, separated by commas or spaces.')
console.log('  Required: an empty allowlist rejects everything.')
console.log('  This is a real access control — a sender not listed here cannot post,')
console.log('  even with passing DKIM.\n')
console.log('    e.g.  someone@example.com, someone-else@example.com\n')

if (await shouldSet(sendersName)) {
  const senders = parseAddressList(await prompt('  Addresses: '))
  const invalid = senders.filter((address) => !looksLikeAddress(address))

  if (senders.length === 0) {
    console.error('  Nothing entered; skipped. The site cannot accept mail until this is set.\n')
  } else if (invalid.length > 0) {
    // Refuse rather than store something that would match no sender at all.
    console.error(`\n  These do not look like email addresses:\n`)
    for (const address of invalid) console.error(`    ${address}`)
    console.error('\n  Nothing was changed. Separate addresses with a comma or a space.\n')
  } else {
    // Echo what will be stored: an allowlist that matches nothing is a silent
    // failure, so it is worth seeing before it is set.
    console.log(`\n  Allowing ${senders.length} sender(s):`)
    for (const address of senders) console.log(`    ${address}`)

    if (await confirm('\n  Set this allowlist?', true)) {
      if (putSecret(sendersName, senders.join(','))) {
        console.log(`  Set ${sendersName}.\n`)
      } else {
        console.error('  wrangler failed; see above.\n')
      }
    } else {
      console.log('  Skipped.\n')
    }
  }
} else {
  console.log(`  Kept the existing ${sendersName}.\n`)
}

// --- API token: optional, generated, and must be shown once.
const tokenName = `${prefix}_API_TOKEN`
console.log(`${tokenName} — bearer token for this site's HTTPS endpoint.`)
console.log('  Optional: omit it for a site that only accepts email.\n')

if (await confirm('  Set an API token?')) {
  if (await shouldSet(tokenName)) {
    const token = generateToken()
    if (putSecret(tokenName, token)) {
      console.log(`\n  Set ${tokenName}. Use it as the bearer token:\n`)
      console.log(`    ${token}\n`)
      console.log('  Save it now — it cannot be read back from Cloudflare.')
      console.log(`\n  curl -X POST https://post-inbox.<subdomain>.workers.dev \\`)
      console.log(`    -H "Authorization: Bearer ${token.slice(0, 8)}..." \\`)
      console.log(`    -H "Content-Type: application/json" \\`)
      console.log(`    -d '{"site":"${requested}","title":"Test","body":"Hello."}'\n`)
    } else {
      console.error('  wrangler failed; see above.\n')
    }
  } else {
    console.log(`  Kept the existing ${tokenName}.\n`)
  }
} else {
  console.log('  Skipped — this site will accept email only.\n')
}

// --- Optional per-site overrides of the two global secrets. ---
const siteGithub = `${prefix}_GITHUB_TOKEN`
const siteSubject = `${prefix}_EMAIL_SUBJECT_TOKEN`

console.log('Optional per-site overrides.')
console.log(`  By default this site uses the global GITHUB_TOKEN and`)
console.log('  EMAIL_SUBJECT_TOKEN. Setting per-site versions means a leaked')
console.log('  credential reaches this site only, rather than all of them.\n')

if (await confirm('  Set a GitHub token just for this site?')) {
  if (await shouldSet(siteGithub)) {
    console.log(`\n  Needs Contents and Pull requests read/write on this site's repo only.`)
    const token = await promptSecret('  Paste the token (not echoed): ')
    if (!token) {
      console.error('  Nothing entered; skipped. This site keeps using GITHUB_TOKEN.\n')
    } else if (/\s/.test(token)) {
      console.error('  That value contains whitespace — a copied newline breaks it. Skipped.\n')
    } else if (putSecret(siteGithub, token)) {
      console.log(`  Set ${siteGithub}.\n`)
    } else {
      console.error('  wrangler failed; see above.\n')
    }
  } else {
    console.log(`  Kept the existing ${siteGithub}.\n`)
  }
} else {
  console.log('  Skipped — this site uses the global GITHUB_TOKEN.\n')
}

if (await confirm('  Set a subject token just for this site?')) {
  if (await shouldSet(siteSubject)) {
    const token = generateToken()
    if (putSecret(siteSubject, token)) {
      console.log(`\n  Set ${siteSubject}. Put this in the subject as [token]:\n`)
      console.log(`    ${token}\n`)
      console.log('  Save it now — it cannot be read back from Cloudflare.\n')
    } else {
      console.error('  wrangler failed; see above.\n')
    }
  } else {
    console.log(`  Kept the existing ${siteSubject}.\n`)
  }
} else {
  console.log('  Skipped — this site uses the global EMAIL_SUBJECT_TOKEN, if set.\n')
}

console.log('Then: pnpm run deploy\n')
