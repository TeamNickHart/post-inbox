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
