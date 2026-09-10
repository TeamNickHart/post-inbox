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
  prompt,
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
console.log('  Comma-separated. Required: an empty allowlist rejects everything.')
console.log('  This is a real access control — a sender not listed here cannot post,')
console.log('  even with passing DKIM.\n')

if (await shouldSet(sendersName)) {
  const raw = await prompt('  Addresses: ')
  const senders = raw
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)

  if (senders.length === 0) {
    console.error('  Nothing entered; skipped. The site cannot accept mail until this is set.\n')
  } else if (senders.some((address) => !address.includes('@'))) {
    console.error(`  Not all of those look like addresses: ${senders.join(', ')}. Skipped.\n`)
  } else if (putSecret(sendersName, senders.join(','))) {
    console.log(`  Set ${sendersName} to ${senders.length} address(es).\n`)
  } else {
    console.error('  wrangler failed; see above.\n')
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

console.log('Then: pnpm deploy\n')
