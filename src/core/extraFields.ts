/**
 * Per-site frontmatter fields, declared in `sites.jsonc`.
 *
 * Sites built on the same template still diverge: one has a `pillar` enum and
 * links posts to a project, another has neither. Hard-coding either would put
 * one site's schema in code that three sites share, so a site declares what it
 * accepts and everything here stays generic.
 *
 * A declared field is readable from the same header block as `Tags:` and
 * `Summary:` (`Pillar: Leading`) and from the HTTPS body. **The declaration is
 * the only way a header line becomes frontmatter** — an undeclared key is left
 * alone as prose, exactly as before this existed.
 */

/**
 * An enum field: a fixed set of stored values, each with the spellings a
 * sender may type for it.
 *
 * Keyed by the value that reaches the frontmatter, because that is the thing
 * the site's schema constrains and the thing a reader of the config needs to
 * see. The aliases are *extra* spellings; a stored value always accepts
 * itself, and matching is case-insensitive throughout.
 *
 * This is why the shape is a map rather than the flat list of stored values it
 * might obviously have been: a site's labels often differ from its stored
 * values — `leadership` shows as "Leading" — and someone writing an email
 * reasonably types what they read on the site.
 */
export interface EnumFieldDefinition {
  type: 'enum'
  /** Stored value → additional accepted spellings. */
  values: Record<string, string[]>
}

/** A free-text field, stored as the sender wrote it. */
export interface StringFieldDefinition {
  type: 'string'
}

export type FieldDefinition = EnumFieldDefinition | StringFieldDefinition

/** Field name as it appears in frontmatter → what it accepts. */
export type ExtraFieldDefinitions = Record<string, FieldDefinition>

export interface FieldError {
  field: string
  /** Safe to show the sender: names the field and what it would accept. */
  message: string
}

export type ResolveResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; errors: FieldError[] }

/**
 * Field names a site may not declare.
 *
 * These are emitted by `renderPost` from the request itself, so letting a site
 * redeclare one would produce a duplicate YAML key — valid to parse, but with
 * the second silently winning, which is the kind of bug that shows up as a post
 * with the wrong date.
 */
const RESERVED = new Set(['title', 'date', 'tags', 'draft', 'summary', 'authors'])

/** Whether a name may be declared as an extra field. */
export function isReservedFieldName(name: string): boolean {
  return RESERVED.has(name.toLowerCase())
}

/**
 * Resolve raw sender input against a site's declarations.
 *
 * Returns every error rather than the first, so a sender who got two fields
 * wrong is told about both instead of discovering the second on their next
 * attempt.
 */
export function resolveExtraFields(
  input: Record<string, string>,
  definitions: ExtraFieldDefinitions | undefined,
): ResolveResult {
  if (!definitions) return { ok: true, values: {} }

  const values: Record<string, string> = {}
  const errors: FieldError[] = []

  for (const [name, raw] of Object.entries(input)) {
    const definition = definitions[name]
    // An undeclared name should never reach here — the header parser only
    // collects declared keys — but the HTTPS path hands over whatever the
    // caller sent, so ignoring it keeps the two paths consistent.
    if (!definition) continue

    const value = raw.trim()
    // An empty value is the sender writing `Pillar:` and nothing else. Treat it
    // as not setting the field rather than as an error, matching how an empty
    // `Summary:` is already ignored.
    if (!value) continue

    if (definition.type === 'string') {
      values[name] = value
      continue
    }

    const stored = matchEnumValue(value, definition)
    if (stored === null) {
      errors.push({ field: name, message: describeEnumError(name, value, definition) })
      continue
    }
    values[name] = stored
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, values }
}

/** The stored value a spelling maps to, or null when nothing matches. */
function matchEnumValue(value: string, definition: EnumFieldDefinition): string | null {
  const wanted = value.toLowerCase()
  for (const [stored, aliases] of Object.entries(definition.values)) {
    if (stored.toLowerCase() === wanted) return stored
    if (aliases.some((alias) => alias.toLowerCase() === wanted)) return stored
  }
  return null
}

/**
 * Explain a rejected value to the sender.
 *
 * Lists the stored value with its aliases in parentheses, since a sender who
 * typed a label is more likely to recognise that than the stored form.
 */
function describeEnumError(name: string, value: string, definition: EnumFieldDefinition): string {
  const accepted = Object.entries(definition.values)
    .map(([stored, aliases]) => (aliases.length > 0 ? `${stored} (or ${aliases.join(', ')})` : stored))
    .join(', ')
  return `\`${name}: ${value}\` is not a valid value — accepted values are ${accepted}`
}
