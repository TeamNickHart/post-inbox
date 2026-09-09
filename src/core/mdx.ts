/**
 * Make a markdown body safe to compile as MDX.
 *
 * The site's posts are `.mdx`, but what arrives in an email is markdown.
 * That mismatch is the whole problem: MDX reads `<` as the start of a JSX
 * element and `{` as the start of a JavaScript expression, so ordinary prose
 * like `Array<int>`, `x <5`, or `{draft}` is a build error rather than text.
 *
 * The approach is deliberately blunt, because the input is prose:
 *
 *  - `<url>` and `<user@host>` autolinks become real markdown links. This is
 *    valid markdown someone might reasonably type, and it should render as a
 *    link rather than as literal angle brackets.
 *  - Every other `<` and every `{` `}` is escaped, so MDX treats it as text.
 *  - Code — fenced blocks and inline backticks — is never touched, because
 *    MDX does not parse JSX inside it.
 *
 * **What this gives up:** raw HTML in the body. Markdown permits
 * `<b>bold</b>`, and after this it renders as visible angle brackets instead
 * of bold text. That is a deliberate trade — an emailed post can use `**`
 * instead, and the alternative is trying to distinguish HTML the author meant
 * from prose that merely looks like a tag, which cannot be done reliably
 * enough to be worth it here.
 *
 * Verified against `@mdx-js/mdx` v3, not assumed.
 */

/**
 * Regions that must not be rewritten: fenced blocks, inline code, and
 * existing markdown links. Splitting on this pattern puts them at odd
 * indices, so only the even (prose) parts get transformed.
 */
const PROTECTED = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\))/g

/** An `<https://…>` or `<mailto:…>` autolink. */
const URL_AUTOLINK = /<((?:https?|mailto):[^>\s]+)>/g

/** A bare `<user@host>` email autolink. */
const EMAIL_AUTOLINK = /<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/g

export interface MdxSafetyResult {
  text: string
  /** Notes on what changed, so the PR can say rather than silently alter. */
  changes: string[]
}

/**
 * Escape MDX-significant characters in a markdown body, leaving code spans
 * and existing links alone.
 */
export function makeMdxSafe(body: string): MdxSafetyResult {
  const changes = new Set<string>()

  const text = body
    .split(PROTECTED)
    .map((part, index) => {
      if (index % 2 === 1) return part

      let prose = part

      prose = prose.replace(URL_AUTOLINK, (_match, url: string) => {
        changes.add('converted an autolink to a markdown link')
        return `[${url}](${url})`
      })

      prose = prose.replace(EMAIL_AUTOLINK, (_match, address: string) => {
        changes.add('converted an email autolink to a markdown link')
        return `[${address}](mailto:${address})`
      })

      // Escape what MDX would otherwise parse as JSX or an expression.
      // The run of backslashes is captured so an already-escaped character
      // is left alone: an odd count means the `<` is escaped, an even count
      // means those backslashes escape each other and the `<` is still live.
      prose = prose.replace(/(\\*)([<{}])/g, (_match, slashes: string, character: string) => {
        if (slashes.length % 2 === 1) return `${slashes}${character}`
        changes.add(
          character === '<'
            ? 'escaped `<` so MDX reads it as text, not a tag'
            : 'escaped `{` or `}` so MDX reads it as text, not an expression',
        )
        return `${slashes}\\${character}`
      })

      return prose
    })
    .join('')

  return { text, changes: [...changes] }
}
