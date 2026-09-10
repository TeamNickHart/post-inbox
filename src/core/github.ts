/**
 * Minimal GitHub REST client covering exactly the calls needed to open a
 * draft-post PR: read a branch head, create a blob/tree/commit, point a
 * new branch at it, and open the pull request.
 *
 * Uses the low-level git data API rather than the Contents API so a
 * commit can be built without any local checkout, and so adding more
 * files per commit later (images) needs no restructuring.
 */

const API = 'https://api.github.com'

export interface GitHubClientOptions {
  /** Installation access token for the GitHub App. */
  token: string
  /** Sent as User-Agent; GitHub rejects requests without one. */
  userAgent?: string
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
}

/**
 * A file to include in a commit.
 *
 * Text and binary take different routes. The tree API accepts inline `content`
 * only as UTF-8, so a binary file has to be uploaded as a base64 blob first and
 * referenced by its SHA — passing bytes as `content` silently corrupts them.
 */
export type FileToCommit =
  | {
      /** Repo-relative path. */
      path: string
      /** UTF-8 text content. */
      content: string
    }
  | {
      path: string
      /** Raw bytes, uploaded as a blob and referenced by SHA. */
      bytes: Uint8Array
    }

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export class GitHubClient {
  #token: string
  #userAgent: string
  #fetch: typeof fetch

  constructor(options: GitHubClientOptions) {
    this.#token = options.token
    this.#userAgent = options.userAgent ?? 'post-inbox'
    // Bind to globalThis: the Workers runtime rejects a detached native
    // `fetch` called as a method with a TypeError ("Illegal invocation").
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.#userAgent,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new GitHubError(
        `GitHub ${method} ${path} failed with ${response.status}`,
        response.status,
        text,
      )
    }
    return (await response.json()) as T
  }

  /** Resolve a branch name to the commit SHA it points at. */
  async getBranchHead(owner: string, repo: string, branch: string): Promise<string> {
    const ref = await this.#request<{ object: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    )
    return ref.object.sha
  }

  /** Look up the tree SHA a commit points at. */
  async getCommitTree(owner: string, repo: string, commitSha: string): Promise<string> {
    const commit = await this.#request<{ tree: { sha: string } }>(
      'GET',
      `/repos/${owner}/${repo}/git/commits/${commitSha}`,
    )
    return commit.tree.sha
  }

  /**
   * Upload raw bytes as a blob and return its SHA.
   *
   * Base64 because the API takes no binary encoding, which inflates the payload
   * by about a third — worth knowing against GitHub's request size limits when
   * committing several images at once.
   */
  async createBlob(owner: string, repo: string, bytes: Uint8Array): Promise<string> {
    const blob = await this.#request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: base64Encode(bytes),
      encoding: 'base64',
    })
    return blob.sha
  }

  /**
   * Create a commit containing `files`, layered on top of `parentSha`.
   * Returns the new commit SHA.
   *
   * Binary files are uploaded as blobs first, in parallel, then referenced by
   * SHA in the tree.
   */
  async createCommit(
    owner: string,
    repo: string,
    parentSha: string,
    files: FileToCommit[],
    message: string,
  ): Promise<string> {
    const baseTree = await this.getCommitTree(owner, repo, parentSha)

    const entries = await Promise.all(
      files.map(async (file) => {
        if ('bytes' in file) {
          return {
            path: file.path,
            mode: '100644' as const,
            type: 'blob' as const,
            sha: await this.createBlob(owner, repo, file.bytes),
          }
        }
        return {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          content: file.content,
        }
      }),
    )

    const tree = await this.#request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTree,
      tree: entries,
    })

    const commit = await this.#request<{ sha: string }>(
      'POST',
      `/repos/${owner}/${repo}/git/commits`,
      { message, tree: tree.sha, parents: [parentSha] },
    )
    return commit.sha
  }

  /** Create a new branch pointing at `commitSha`. */
  async createBranch(
    owner: string,
    repo: string,
    branch: string,
    commitSha: string,
  ): Promise<void> {
    await this.#request('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commitSha,
    })
  }

  /** Check whether a branch already exists. */
  async branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
    try {
      await this.getBranchHead(owner, repo, branch)
      return true
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return false
      throw error
    }
  }

  /** Open a pull request and return its number and URL. */
  async createPullRequest(
    owner: string,
    repo: string,
    options: { title: string; head: string; base: string; body: string },
  ): Promise<{ number: number; html_url: string }> {
    return await this.#request<{ number: number; html_url: string }>(
      'POST',
      `/repos/${owner}/${repo}/pulls`,
      options,
    )
  }
}

/**
 * Base64-encode bytes without Node's Buffer, which Workers does not provide.
 *
 * Chunked because spreading a large array into `String.fromCharCode` overflows
 * the call stack somewhere in the low hundreds of thousands of arguments — and
 * an image is comfortably past that.
 */
function base64Encode(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
