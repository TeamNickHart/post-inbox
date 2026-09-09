/**
 * Optional metadata a sender can put at the top of an email body.
 *
 * A leading block of `Key: value` lines sets frontmatter that the subject
 * line cannot express:
 *
 *     Tags: Coding, iOS, job application
 *     Summary: What I learned shipping this.
 *
 *     The post body starts here.
 *
 * Deliberately narrow. Only a contiguous run of recognised keys at the very
 * start of the body counts, and the first line that is not one ends the
 * block — so prose that happens to contain a colon is never mistaken for
 * metadata. An unrecognised key is left alone as body text rather than
 * silently dropped, because guessing wrong loses someone's writing.
 */

/** Keys understood at the top of a body. Everything else is prose. */
const KNOWN_KEYS = new Set(['tags', 'summary'])

const HEADER_LINE = /^([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]*(.*)$/

export interface ParsedHeaders {
  tags?: string[]
  summary?: string
  /** The body with the header block removed. */
  body: string
}

/**
 * Split a leading `Key: value` block off the front of a body.
 *
 * Tag values keep their case and internal spaces — the site's existing posts
 * use tags like `IKEA`, `SwiftLint` and `job application`, so normalising
 * would both change their meaning and fragment the tag list.
 */
export function parseHeaders(body: string): ParsedHeaders {
  const lines = body.split('\n')
  const result: ParsedHeaders = { body }
  const found = new Map<string, string>()

  let index = 0
  for (; index < lines.length; index++) {
    const line = lines[index]!

    // A blank line ends the block, but only once something was found —
    // otherwise leading whitespace would stop parsing before it starts.
    if (line.trim() === '') {
      if (found.size > 0) break
      continue
    }

    const match = HEADER_LINE.exec(line)
    const key = match?.[1]?.toLowerCase()
    if (!match || !key || !KNOWN_KEYS.has(key) || found.has(key)) break

    found.set(key, match[2]!.trim())
  }

  if (found.size === 0) return result

  const tags = found.get('tags')
  if (tags !== undefined) {
    const parsed = splitTags(tags)
    if (parsed.length > 0) result.tags = parsed
  }

  const summary = found.get('summary')
  if (summary) result.summary = summary

  result.body = lines.slice(index).join('\n').trim()
  return result
}

/**
 * Split a tag list on commas.
 *
 * Commas only: a tag may contain spaces (`job application` is a real tag on
 * the site), so splitting on whitespace would break existing conventions.
 */
function splitTags(value: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []

  for (const raw of value.split(',')) {
    const tag = raw.trim()
    if (!tag) continue
    // De-duplicate case-insensitively but keep the first spelling, so
    // "iOS, ios" yields one tag rather than two that differ only in case.
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
  }
  return tags
}
