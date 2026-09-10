/**
 * Compile `sites.jsonc` into `src/generated/sites.json`.
 *
 * The Worker cannot import the .jsonc directly: esbuild's JSON loader rejects
 * comments, and the comments are the reason for choosing .jsonc over .json in
 * the first place. So the committed file stays commented and human-edited,
 * and this strips the comments into a plain JSON module for the bundle.
 *
 * Runs automatically before `dev` and `deploy`. Also validates, so a bad
 * config fails here rather than when an email arrives.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateSites } from '../src/core/sites.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = `${root}sites.jsonc`
const target = `${root}src/generated/sites.json`

/**
 * Strip `//` and block comments, leaving string literals alone.
 *
 * Hand-rolled rather than pulled from npm: the input is a file in this repo,
 * not untrusted data, and a dependency for this is not worth it.
 */
function stripComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (char === '\n') { inLine = false; out += char }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') { out += text[++i] ?? '' }
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') { inLine = true; continue }
    if (char === '/' && next === '*') { inBlock = true; i++; continue }
    out += char
  }
  // Trailing commas are legal in JSONC but not JSON.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const parsed = JSON.parse(stripComments(readFileSync(source, 'utf8')))
const sites = validateSites(parsed)

mkdirSync(`${root}src/generated`, { recursive: true })
writeFileSync(target, `${JSON.stringify({ sites }, null, 2)}\n`)

console.log(`Compiled ${sites.length} site(s) from sites.jsonc:`)
for (const site of sites) {
  console.log(`  ${site.key.padEnd(12)} ${site.inboundAddresses.join(', ')} -> ${site.owner}/${site.repo}`)
}
