/**
 * Email signature stripping.
 *
 * The only rule applied is the standardized one: RFC 3676 §4.3 defines a
 * signature as everything following a line consisting of exactly two
 * hyphens and a space (`"-- "`). Mail clients that honour it — Apple Mail,
 * Gmail, Thunderbird, Outlook — produce a delimiter we can cut on without
 * guessing.
 *
 * A bare `--` (no trailing space) is also accepted, because relays and
 * clients routinely trim trailing whitespace and would otherwise defeat the
 * rule. Three or more hyphens are left alone — that is a markdown
 * horizontal rule, not a delimiter.
 *
 * Deliberately not attempted: recognising signatures by shape (a trailing
 * block that looks like a name and a URL), "Sent from my iPhone", or quoted
 * reply chains. Those are heuristics, and one that silently eats a
 * paragraph of someone's post is worse than leaving a signature in for them
 * to delete. Anyone with a non-conforming signature can turn stripping off
 * and handle it themselves.
 */

/**
 * A signature delimiter line: exactly two hyphens, optional trailing
 * whitespace, alone on its own line. A third hyphen makes it a markdown
 * rule instead, so the pattern must not match one.
 */
const DELIMITER = /\n--[ \t]*\r?\n(?!-)/

/**
 * Remove an RFC 3676 signature block from a plaintext email body.
 *
 * Cuts at the *last* delimiter, so a body that legitimately contains an
 * earlier `-- ` line keeps everything up to the final one — the signature
 * a client appends is always last.
 *
 * Returns the body unchanged when there is no delimiter, and also when
 * cutting would leave nothing behind: a body that is *only* a signature is
 * more likely a delimiter used as a horizontal rule than an empty post.
 */
export function stripSignature(body: string): string {
  // Normalize CRLF so the delimiter matches regardless of transport, but
  // only for the search — the returned text keeps its original line endings.
  const matchIndex = lastDelimiterIndex(body)
  if (matchIndex === null) return body

  const stripped = body.slice(0, matchIndex).replace(/\s+$/, '')
  if (!stripped) return body
  return stripped
}

function lastDelimiterIndex(body: string): number | null {
  let found: number | null = null
  const pattern = new RegExp(DELIMITER.source, 'g')
  let match: RegExpExecArray | null

  while ((match = pattern.exec(body)) !== null) {
    found = match.index
    // Step forward past the newline so overlapping delimiters still match.
    pattern.lastIndex = match.index + 1
  }
  return found
}
