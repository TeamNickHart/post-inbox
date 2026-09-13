/**
 * Set the secrets the notification Action needs, in the blog repos.
 *
 *     pnpm configure:notify
 *
 * These live in a different place from every other secret in this project, and
 * the distinction is worth stating: `pnpm configure` and
 * `pnpm configure:site` set **Cloudflare Worker** secrets with
 * `wrangler secret put`, because the Worker reads them. The notification email
 * is sent by a **GitHub Action** running in each blog repo, so its secrets go
 * to GitHub with `gh secret set`.
 *
 * Two secrets per blog repo:
 *
 *   RESEND_API_KEY    the credential, identical across sites
 *   AUTHOR_EMAIL_MAP  that site's author name -> one address to notify
 *
 * The map is derived from `sites.jsonc` rather than hand-written, so it cannot
 * drift from the allowlist it shares a source with. Where a name has several
 * sending addresses the first wins: the others may still post, but only one
 * address is told about it.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { confirm, promptSecret } from './lib/secrets.mjs'
import { notifyAddressByAuthor, validateSites } from '../src/core/sites.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

function readSites() {
  const text = readFileSync(`${root}sites.jsonc`, 'utf8')
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return validateSites(JSON.parse(stripped))
}

/** Does this token carry the scope needed for org-level secrets? */
function canSetOrgSecrets() {
  try {
    const out = execFileSync('gh', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return /admin:org/.test(out)
  } catch {
    return false
  }
}

/** Set one repo secret, piping the value so it never reaches the shell. */
function setRepoSecret(repo, name, value) {
  const result = spawnSync('gh', ['secret', 'set', name, '--repo', repo], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return result.status === 0
}

const sites = readSites()

console.log('\nSecrets for the notification Action, set in each blog repo.\n')

if (!canSetOrgSecrets()) {
  // An org secret would be one place to rotate the key rather than three.
  console.log('Note: your gh token has no `admin:org` scope, so these are set per repo.')
  console.log('      One org-level RESEND_API_KEY would be one place to rotate instead')
  console.log('      of three. To switch later:  gh auth refresh -h github.com -s admin:org\n')
}

// --- RESEND_API_KEY: the same credential for every site. ---
console.log('RESEND_API_KEY — from https://resend.com/api-keys')
console.log('  Sending permission is enough; it does not need full access.\n')

let resendKey = null
if (await confirm('  Set the Resend API key?')) {
  resendKey = await promptSecret('  Paste the key (not echoed): ')
  if (!resendKey) {
    console.error('  Nothing entered; skipped.\n')
  } else if (/\s/.test(resendKey)) {
    console.error('  That value contains whitespace — a copied newline breaks it. Skipped.\n')
    resendKey = null
  } else if (!resendKey.startsWith('re_')) {
    // Resend keys are prefixed; a value without it is almost certainly the
    // wrong secret pasted by mistake.
    console.error(`  That does not look like a Resend key (expected a "re_" prefix). Skipped.\n`)
    resendKey = null
  }
} else {
  console.log('  Skipped.\n')
}

// --- AUTHOR_EMAIL_MAP: derived per site. ---
console.log('AUTHOR_EMAIL_MAP — derived from sites.jsonc, one per repo.\n')

for (const site of sites) {
  const repo = `${site.owner}/${site.repo}`
  const map = notifyAddressByAuthor(site)
  const names = Object.keys(map)

  // Masked: the point of this script is to move addresses around without
  // printing them into a terminal scrollback or CI log.
  const preview = names
    .map((name) => `${name} -> ${map[name].replace(/^(.).*(@.*)$/, '$1***$2')}`)
    .join(', ')
  console.log(`  ${repo}`)
  console.log(`    ${names.length} author(s): ${preview}`)

  if (resendKey && setRepoSecret(repo, 'RESEND_API_KEY', resendKey)) {
    console.log('    set RESEND_API_KEY')
  }
  if (setRepoSecret(repo, 'AUTHOR_EMAIL_MAP', JSON.stringify(map))) {
    console.log('    set AUTHOR_EMAIL_MAP')
  } else {
    console.error('    failed to set AUTHOR_EMAIL_MAP; see above')
  }
  console.log()
}

console.log('Done. These are read by the notification workflow in each blog repo.\n')
