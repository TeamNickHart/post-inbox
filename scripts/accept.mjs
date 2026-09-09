/**
 * Regenerate the acceptance-test fixture.
 *
 * Run after a deliberate change to the transformation pipeline, then read the
 * diff before committing — `expected.mdx` is the specification of what an
 * emailed post becomes, so a change to it is a change to the contract.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderPost } from '../src/core/markdown.ts'

const dir = fileURLToPath(new URL('../examples/acceptance-test/', import.meta.url))

const output = renderPost({
  title: 'Markdown Acceptance Test',
  date: new Date('2026-01-15T12:00:00Z'),
  author: 'you@example.com',
  body: readFileSync(`${dir}body.md`, 'utf8'),
})

writeFileSync(`${dir}expected.mdx`, output)
console.log('Regenerated examples/acceptance-test/expected.mdx')
console.log('Review it with `git diff examples/` before committing.')
