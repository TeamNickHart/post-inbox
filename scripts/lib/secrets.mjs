/**
 * Shared helpers for the `configure` scripts.
 *
 * Generated values are piped straight into `wrangler secret put` on stdin
 * rather than typed at its prompt. That matters: the token never reaches the
 * clipboard, the terminal scrollback, or shell history, and there is no paste
 * step to get wrong — pasting the wrong one of several similar-looking hex
 * strings is a mistake that costs a confusing 401 to diagnose.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))

/** 24 random bytes as hex, matching `openssl rand -hex 24`. */
export function generateToken() {
  return randomBytes(24).toString('hex')
}

/** Read the site keys out of sites.jsonc, without pulling in a JSONC parser. */
export function readSiteKeys() {
  let text
  try {
    text = readFileSync(`${root}sites.jsonc`, 'utf8')
  } catch {
    throw new Error('sites.jsonc not found — copy sites.example.jsonc first')
  }
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(stripped).sites.map((site) => site.key)
}

/** The environment-variable prefix for a site key. */
export function secretPrefix(key) {
  return key.toUpperCase().replace(/-/g, '_')
}

/**
 * Names of the secrets already set on the deployed Worker, or null if that
 * cannot be determined (not deployed yet, or not logged in).
 */
export function existingSecretNames() {
  try {
    const out = execFileSync('npx', ['wrangler', 'secret', 'list'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new Set(JSON.parse(out).map((entry) => entry.name))
  } catch {
    return null
  }
}

/** Set one secret by piping `value` to `wrangler secret put`. Never logs it. */
export function putSecret(name, value) {
  const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: root,
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  return result.status === 0
}

/** Prompt for a value without echoing it. */
export async function promptSecret(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const output = rl.output
  let muted = false
  const originalWrite = output.write.bind(output)
  output.write = (chunk, ...rest) => (muted ? true : originalWrite(chunk, ...rest))

  process.stdout.write(question)
  muted = true
  try {
    return (await rl.question('')).trim()
  } finally {
    muted = false
    output.write = originalWrite
    process.stdout.write('\n')
    rl.close()
  }
}

/** Prompt for a plain (echoed) value. */
export async function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Ask a yes/no question. */
export async function confirm(question, defaultYes = false) {
  const answer = await prompt(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)
  if (!answer) return defaultYes
  return /^y(es)?$/i.test(answer)
}
