/**
 * Suggest a hard-to-guess local part for an inbound address.
 *
 *     pnpm generate:address            # a few suggestions
 *     pnpm generate:address example.com
 *
 * Why bother, given the README is clear that a secret address is not the
 * security control? Because a guessable address like `draft@` gets found by
 * address-harvesting bots, and every junk message wakes the Worker, burns an
 * invocation and adds a rejection to the logs. A random address gets almost no
 * unsolicited traffic. It is noise reduction, not access control — an address
 * that leaks costs you nothing but a rotation.
 *
 * Word-pair form is deliberate: memorable enough to type into a mail client
 * and recognise in a routing rule, unlike a hex string.
 */
import { randomInt } from 'node:crypto'

const ADJECTIVES = [
  'amber', 'brisk', 'cosmic', 'dapper', 'eager', 'fluent', 'gentle', 'hazy',
  'ivory', 'jolly', 'keen', 'lunar', 'mellow', 'nimble', 'opal', 'plucky',
  'quiet', 'rustic', 'sunny', 'tidal', 'upbeat', 'velvet', 'wistful', 'zesty',
  'candid', 'frosty', 'golden', 'humble', 'marble', 'placid', 'sable', 'wooly',
]

const NOUNS = [
  'anchor', 'beacon', 'canyon', 'delta', 'ember', 'fathom', 'granite', 'harbor',
  'inlet', 'juniper', 'kettle', 'lantern', 'meadow', 'nectar', 'orchard', 'pebble',
  'quarry', 'ridge', 'summit', 'thicket', 'umber', 'vessel', 'willow', 'zephyr',
  'bramble', 'cobalt', 'driftwood', 'foxglove', 'lattice', 'marlin', 'saffron', 'trellis',
]

/**
 * A word pair plus two digits.
 *
 * Roughly 32 × 32 × 100 ≈ 100k combinations. That is nowhere near enough to
 * resist a determined attacker, and it does not need to be — the allowlist and
 * DKIM do that work. It is enough that a bot guessing common local parts
 * (`info@`, `draft@`, `blog@`) will not stumble onto it.
 */
function suggest() {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)]
  const noun = NOUNS[randomInt(NOUNS.length)]
  return `${adjective}-${noun}${randomInt(10, 100)}`
}

const domain = process.argv[2]
const count = 5

console.log(`\nSuggested inbound addresses${domain ? ` for ${domain}` : ''}:\n`)
for (let i = 0; i < count; i++) {
  const local = suggest()
  console.log(`  ${domain ? `${local}@${domain}` : local}`)
}

console.log(`
Pick one per site, then:

  1. Cloudflare dashboard -> Email -> Email Routing -> Routing rules
     -> Create address, action "Send to a Worker" -> post-inbox
  2. Add it to that site's "inboundAddresses" in sites.jsonc (gitignored)
  3. pnpm deploy

A guessable address is not a security hole — the sender allowlist and DKIM
checks are what stop a stranger posting. This just keeps harvesting bots from
finding the address at all, so the Worker is not woken by junk.
`)
