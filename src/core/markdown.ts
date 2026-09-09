import { makeMdxSafe } from './mdx.ts'
import type { DraftPostRequest } from './types.ts'

/**
 * Turn a title into a URL/filename-safe slug.
 *
 * Matches the existing post filenames in the blog repo: lowercase,
 * words joined by hyphens, punctuation dropped entirely (so
 * "Long time no see…" becomes "long-time-no-see").
 */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    // Strip combining marks so accented letters reduce to ASCII.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!slug) {
    throw new Error('Title produced an empty slug')
  }
  return slug
}

/** Format a date as the `YYYY-MM-DD` string the frontmatter uses. */
export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid date')
  }
  return date.toISOString().slice(0, 10)
}

/**
 * Quote a value as a single-quoted YAML string, matching the style of
 * the existing posts. Embedded single quotes are doubled, which is how
 * YAML escapes them inside single-quoted scalars.
 */
function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Wrap bare URLs in markdown link syntax.
 *
 * Skips URLs that are already part of a `[text](url)` or `<url>`
 * construct, URLs inside fenced or inline code, and the target of a
 * reference-link definition (`[ref]: https://…`) — rewriting that last one
 * breaks every reference pointing at it.
 */
export function linkifyBareUrls(body: string): string {
  // Split on the constructs we must leave alone. Because the pattern is
  // fully parenthesized, the delimiters are preserved in the output
  // array at odd indices — we only transform the even (plain-text) ones.
  const protectedPattern =
    /(```[\s\S]*?```|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<https?:\/\/[^>\s]+>|^[ \t]*\[[^\]]+\]:[ \t]*\S+)/gm
  const parts = body.split(protectedPattern)

  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part.replace(/(^|[\s(])(https?:\/\/[^\s<>()[\]]+)/g, (_m, lead: string, url: string) => {
        // Trailing sentence punctuation belongs to the prose, not the URL.
        const trailing = url.match(/[.,;:!?]+$/)?.[0] ?? ''
        const clean = trailing ? url.slice(0, -trailing.length) : url
        return `${lead}[${clean}](${clean})${trailing}`
      })
    })
    .join('')
}

/**
 * Render a full post file: YAML frontmatter plus the body.
 *
 * `draft: true` is always set — this system never publishes directly,
 * it only ever opens a PR for review.
 */
export function renderPost(request: DraftPostRequest): string {
  const lines = [
    '---',
    `title: ${yamlString(request.title)}`,
    `date: ${yamlString(formatDate(request.date))}`,
  ]

  const tags = request.tags ?? []
  lines.push(`tags: [${tags.map(yamlString).join(', ')}]`)
  lines.push('draft: true')

  if (request.summary) {
    lines.push(`summary: ${yamlString(request.summary)}`)
  }

  // `authors` is only emitted when the adapter resolved a real author
  // file in `data/authors`. An unknown key would reference a file that
  // does not exist and break the site build, so we fall through to the
  // template's own `default` author instead.
  if (request.authorFile) {
    lines.push(`authors: [${yamlString(request.authorFile)}]`)
  }
  lines.push('---', '')

  // Escaping runs last: `linkifyBareUrls` produces markdown links, which
  // `makeMdxSafe` treats as protected regions and leaves alone.
  const body = makeMdxSafe(linkifyBareUrls(request.body.trim())).text
  return `${lines.join('\n')}\n${body}\n`
}
