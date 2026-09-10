/**
 * Check that every author named in `sites.jsonc` exists in its repo.
 *
 *     pnpm check:authors
 *
 * This is the one thing `validateSites` cannot do: frontmatter naming an author
 * with no matching file in `data/authors` breaks the site build, and only the
 * target repo can say whether the file is there. Run it after editing an
 * `authorsBySender` map.
 *
 * Uses the `gh` CLI so it works with your own credentials rather than needing
 * the Worker's token.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))

const text = readFileSync(`${root}sites.jsonc`, 'utf8')
const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const { sites } = JSON.parse(stripped)

/** Author basenames present in a repo's data/authors directory. */
function authorsInRepo(owner, repo, contentPath) {
  // Authors live beside the content directory, one level up: data/blog ->
  // data/authors.
  const dir = `${contentPath.split('/').slice(0, -1).join('/') || 'data'}/authors`
  try {
    const out = execFileSync(
      'gh',
      ['api', `/repos/${owner}/${repo}/contents/${dir}`, '--jq', '.[].name'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return new Set(out.split('\n').filter(Boolean).map((name) => name.replace(/\.mdx?$/i, '')))
  } catch {
    return null
  }
}

let problems = 0

for (const site of sites) {
  const map = site.authorsBySender
  if (!map || Object.keys(map).length === 0) {
    console.log(`${site.key.padEnd(12)} no author map — posts use the site default`)
    continue
  }

  const present = authorsInRepo(site.owner, site.repo, site.contentPath)
  if (present === null) {
    console.log(`${site.key.padEnd(12)} could not read data/authors (no access, or none exists)`)
    problems++
    continue
  }

  const named = [...new Set(Object.values(map))]
  const missing = named.filter((author) => !present.has(author))

  if (missing.length === 0) {
    console.log(`${site.key.padEnd(12)} ${named.length} author(s) all present: ${named.join(', ')}`)
  } else {
    console.log(`${site.key.padEnd(12)} MISSING: ${missing.join(', ')}`)
    console.log(`${''.padEnd(12)} present:  ${[...present].join(', ')}`)
    problems++
  }
}

if (problems > 0) {
  console.error(
    `\n${problems} site(s) with a problem. An author with no file breaks the site build.`,
  )
  process.exit(1)
}
console.log('\nEvery mapped author has a file.')
