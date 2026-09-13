/**
 * Refuse to commit files that must never be published.
 *
 * This repo is public, and `sites.jsonc` names the addresses that accept mail
 * and the repos that get written to. A .gitignore entry is the first line of
 * defence, but `git add -f` bypasses it and a future rename could miss it —
 * so this checks what is actually staged.
 *
 * Run by `pnpm verify`, and suitable for a pre-commit hook.
 *
 * Two modes, because "what is staged" is meaningless on a CI runner — there,
 * nothing is staged and the check would pass by inspecting zero files:
 *
 *   (no argument)  the staged diff, for a pre-commit hook or a local verify
 *   --tracked      every tracked file, for CI, where the question is whether
 *                  anything forbidden ever landed on the branch
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Paths that must never appear in a commit. */
const FORBIDDEN = [/^sites\.jsonc$/, /^\.dev\.vars$/, /^src\/generated\//]

/**
 * Content patterns that suggest a real secret rather than a placeholder.
 * Deliberately narrow: a noisy check gets ignored, which is worse than none.
 */
const SECRET_PATTERNS = [
  { name: 'GitHub token', pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/ },
  { name: 'GitHub fine-grained PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { name: 'private key', pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]

const tracked = process.argv.includes('--tracked')

const files = execFileSync(
  'git',
  tracked ? ['ls-files'] : ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)

const problems = []

for (const file of files) {
  if (FORBIDDEN.some((pattern) => pattern.test(file))) {
    problems.push(`${file} must never be committed — it is gitignored for a reason`)
  }
}

if (files.length > 0) {
  // Staged mode reads the diff, so a secret is caught as it is introduced.
  // Tracked mode reads the files themselves, since there is no diff to read
  // and the question is whether a secret is present at all.
  const haystack = tracked
    ? files
        .map((file) => {
          try {
            return readFileSync(file, 'utf8')
          } catch {
            // Binary or unreadable: the content patterns are all ASCII, so
            // skipping it loses nothing.
            return ''
          }
        })
        .join('\n')
    : execFileSync('git', ['diff', '--cached', '-U0'], { encoding: 'utf8' })

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(haystack)) {
      problems.push(`${tracked ? 'the tracked tree' : 'staged diff'} appears to contain a ${name}`)
    }
  }
}

if (problems.length > 0) {
  console.error('Refusing to proceed:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nUnstage these before committing.')
  process.exit(1)
}

console.log(
  `Checked ${files.length} ${tracked ? 'tracked' : 'staged'} file(s): nothing forbidden.`,
)
