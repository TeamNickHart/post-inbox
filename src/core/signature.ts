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
 * A second, narrower rule exists because the standard one is not enough in
 * practice: **iOS Gmail appends a signature with no delimiter at all**, as bare
 * trailing lines. Observed on real mail, where it put a name, an email address
 * and a URL into a post — and since a post becomes a pull request on a public
 * repository, that is a privacy problem rather than a tidiness one.
 *
 * So `stripTrailingContactBlock` cuts a trailing block *only* when it looks
 * unmistakably like contact details rather than prose. Its conditions are
 * deliberately conjunctive and it bails on anything ambiguous — see the
 * function for the list. The principle from before still holds: silently
 * eating a paragraph of someone's writing is worse than leaving a signature
 * for them to delete, so every rule here errs towards leaving text alone.
 *
 * Still deliberately not attempted: "Sent from my iPhone" taglines, quoted
 * reply chains, and any block without an address or URL in it. A signature
 * that is only a name is indistinguishable from a one-word closing line.
 */

/**
 * A signature delimiter line: exactly two hyphens, alone on its own line.
 *
 * Leading whitespace is allowed because some clients indent the delimiter, and
 * the trailing set includes the non-breaking spaces (`\u00a0`, `\u2007`,
 * `\u202f`) that clients substitute for the RFC's plain space — both are still
 * a literal `--` delimiter rather than a guess about shape.
 *
 * A third hyphen makes it a markdown horizontal rule instead, so the pattern
 * must not match one.
 */
const DELIMITER = /\n[ \t]*--[ \t\u00a0\u2007\u202f]*\r?\n(?!-)/

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
  if (matchIndex !== null) {
    const stripped = body.slice(0, matchIndex).replace(/\s+$/, '')
    // A body that is *only* a signature is more likely a delimiter used as a
    // horizontal rule than an empty post.
    if (stripped) return stripped
    return body
  }

  // No delimiter: fall back to the narrow contact-block rule, since the client
  // that prompted it writes no delimiter at all.
  return stripTrailingContactBlock(body)
}

/** Lines that give a block away as contact details rather than prose. */
const BARE_EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
const BARE_URL = /^(?:https?:\/\/|www\.)\S+$/i
/** The same, wrapped by the linkifier that runs before this. */
const LINKIFIED_URL = /^\[(?:https?:\/\/|www\.)\S+\]\((?:https?:\/\/|www\.)\S+\)$/i
/** Markdown that means the block is content, whatever else it contains. */
const MARKDOWN_STRUCTURE = /^(?:#{1,6} |[-*+] |\d+\. |>|```|!\[)/

/**
 * A block this long is prose that happens to mention an address.
 *
 * Five, sized for the personal signatures this actually sees — a name, maybe a
 * title, an address and a URL. A full corporate signature (name, title,
 * company, two address lines, email, phone) runs to seven and will be left in,
 * deliberately: raising the cap to fit one costs false positives on real
 * writing, and the people posting here send from personal accounts.
 *
 * Someone with a longer signature should use the `-- ` delimiter, which is
 * matched exactly and needs no guessing at all.
 */
const MAX_BLOCK_LINES = 5
/**
 * A line this long is a sentence, not a contact detail. **Per line**, not for
 * the block, so a long signature of short lines is still caught.
 *
 * Sixty is comfortable rather than tight: the widest line in any realistic
 * signature measured was 48 characters, a job title. What rejects prose is
 * mostly the rules below, not this.
 */
const MAX_LINE_LENGTH = 60
/**
 * How far from the end a contact line may sit.
 *
 * This is the rule that separates a signature from a short paragraph that
 * happens to contain a URL: a signature *ends* with its contact details, while
 * prose mentions a link mid-thought and carries on. Without it, a closing
 * paragraph, a lyric block, a recipe list and a changelog all match — each is
 * short lines containing a URL.
 */
const CONTACT_WITHIN_LAST = 2

/**
 * Cut a trailing block that is unmistakably contact details.
 *
 * Every condition must hold, and anything ambiguous is left alone:
 *
 *  - it is the **last** block, separated from the body by a blank line
 *  - something remains above it, so a post that is only a signature survives
 *  - at most `MAX_BLOCK_LINES` short lines, none over `MAX_LINE_LENGTH`
 *  - **one of the last two lines is nothing but an email address or a URL** —
 *    the load-bearing condition. A signature ends with its contact details;
 *    prose mentions a link mid-thought and keeps going
 *  - no markdown structure anywhere in it: a heading, list, quote, fence or
 *    image means it is content
 *
 * The address requirement is what keeps this from being a general "does the
 * end look like a sign-off" guess. A sign-off with no contact details reads
 * exactly like a closing line, so it stays.
 */
function stripTrailingContactBlock(body: string): string {
  // Blocks are separated by a blank line, which is also how a client visually
  // sets a signature apart from the message.
  const blocks = body.split(/\r?\n[ \t]*\r?\n/)
  if (blocks.length < 2) return body

  const last = blocks[blocks.length - 1]!
  const lines = last.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0 || lines.length > MAX_BLOCK_LINES) return body

  if (lines.some((line) => line.trim().length > MAX_LINE_LENGTH)) return body
  if (lines.some((line) => MARKDOWN_STRUCTURE.test(line.trim()))) return body

  // A heading immediately above means the block is that section's content —
  // a `## Links` section of bare URLs is a post, not a signature. The markdown
  // check above only sees the final block, so this looks one block further up.
  const previous = blocks[blocks.length - 2]!
  const previousLines = previous.split(/\r?\n/).filter((line) => line.trim() !== '')
  const lastOfPrevious = previousLines[previousLines.length - 1]?.trim() ?? ''
  if (/^#{1,6} /.test(lastOfPrevious)) return body

  // Only the last couple of lines count: see CONTACT_WITHIN_LAST.
  const hasContact = lines.slice(-CONTACT_WITHIN_LAST).some((line) => {
    const trimmed = line.trim()
    return BARE_EMAIL.test(trimmed) || BARE_URL.test(trimmed) || LINKIFIED_URL.test(trimmed)
  })
  if (!hasContact) return body

  // Cut at the start of the final block, then trim the blank line that
  // separated it.
  const cut = body.lastIndexOf(last)
  const stripped = body.slice(0, cut).replace(/\s+$/, '')
  return stripped || body
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
