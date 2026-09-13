import type { FileToCommit } from './github.ts'

/**
 * Host-agnostic types for the post-inbox core.
 *
 * Nothing in `src/core` may import Cloudflare (or any other runtime)
 * specific APIs — see the architecture principle in the design doc.
 */

/** A post as requested by an ingestion adapter, before any transformation. */
export interface DraftPostRequest {
  title: string
  /** Plaintext markdown body, as the author typed it. */
  body: string
  /** When the post was authored. Adapters pass the email/request timestamp. */
  date: Date
  /** Author key, resolved by the adapter from the sender or bearer token. */
  author: string
  /**
   * Basename of a file in the site's `data/authors` directory, without
   * extension. Omit to let the site fall back to its `default` author.
   */
  authorFile?: string
  tags?: string[]
  summary?: string
  /** Extra files to include in the same commit, e.g. attachments. */
  extraFiles?: FileToCommit[]
  /**
   * Attachments that could not be committed, as `filename — reason` notes.
   *
   * Surfaced in the pull request body rather than bounced. The post itself
   * succeeded, so rejecting the message would throw the writing away to report
   * a dropped photo — the wrong trade. But saying nothing is worse: a silently
   * dropped attachment is invisible to the sender, which is exactly what
   * happened before this existed.
   */
  rejectedAttachments?: { filename: string; reason: string }[]
  /**
   * Attachments converted to a renderable format on the way in.
   *
   * Noted in the pull request as a success rather than a warning: a reviewer
   * seeing a JPEG where the sender is certain they attached a HEIC should not
   * have to guess, and if a conversion ever degrades an image this is the
   * breadcrumb back to why.
   */
  convertedAttachments?: { filename: string; from: string }[]
  /**
   * Value for the post's `draft` frontmatter field.
   *
   * Defaults to false. The pull request is already the gate that stops a
   * post going live, and many site templates — the Tailwind Nextjs Starter
   * Blog among them — exclude drafts from production builds entirely, which
   * means a `draft: true` post 404s on the very preview deployment meant for
   * reviewing it.
   *
   * Set it true when you would rather merge the post to the main branch
   * unpublished and flip the flag in a separate commit later.
   */
  draft?: boolean
}

/** Where and how to commit. Everything site-specific lives here. */
export interface SiteConfig {
  /** GitHub owner, e.g. "TeamNickHart". */
  owner: string
  /** GitHub repo name, e.g. "your-blog". */
  repo: string
  /** Branch new post branches are cut from and PRs target. */
  baseBranch: string
  /** Repo-relative directory holding posts, e.g. "data/blog". */
  contentPath: string
  /** File extension for posts, including the dot, e.g. ".mdx". */
  extension: string
  /**
   * Where attachments are committed and how the site serves them. Omit to
   * refuse attachments for this site.
   *
   * For the Tailwind Nextjs Starter Blog: directory `public/static/images`,
   * urlPrefix `/static/images`.
   */
  assets?: {
    directory: string
    urlPrefix: string
    /**
     * Convert formats a browser cannot render — chiefly HEIC from an iPhone —
     * into JPEG on the way in. Defaults to **true**: a site that accepts
     * attachments at all wants renderable ones, and leaving it off would mean a
     * photo from an iPhone is refused rather than committed.
     *
     * Set false to keep the refusal behaviour, which is also what happens
     * automatically when no converter is available to the adapter.
     */
    convertImages?: boolean
  }
}

/** The result of a successful post creation. */
export interface DraftPostResult {
  branch: string
  /** Repo-relative path of the committed file. */
  path: string
  commitSha: string
  pullRequestUrl: string
  pullRequestNumber: number
}
