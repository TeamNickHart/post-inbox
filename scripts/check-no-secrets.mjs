/**
 * Refuse to commit files that must never be published.
 *
 * This repo is public, and `sites.jsonc` names the addresses that accept mail
 * and the repos that get written to. A .gitignore entry is the first line of
 * defence, but `git add -f` bypasses it and a future rename could miss it —
 * so this checks what is actually staged.
 *
 * Run by `pnpm verify`, and suitable for a pre-commit hook.
 */
import { execFileSync } from 'node:child_process'

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

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)

const problems = []

for (const file of staged) {
  if (FORBIDDEN.some((pattern) => pattern.test(file))) {
    problems.push(`${file} must never be committed — it is gitignored for a reason`)
  }
}

if (staged.length > 0) {
  const diff = execFileSync('git', ['diff', '--cached', '-U0'], { encoding: 'utf8' })
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(diff)) problems.push(`staged diff appears to contain a ${name}`)
  }
}

if (problems.length > 0) {
  console.error('Refusing to proceed:\n')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nUnstage these before committing.')
  process.exit(1)
}

console.log(`Checked ${staged.length} staged file(s): nothing forbidden.`)
