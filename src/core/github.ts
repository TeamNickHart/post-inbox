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

export interface FileToCommit {
  /** Repo-relative path. */
  path: string
  /** UTF-8 text content. */
  content: string
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
   * Create a commit containing `files`, layered on top of `parentSha`.
   * Returns the new commit SHA.
   */
  async createCommit(
    owner: string,
    repo: string,
    parentSha: string,
    files: FileToCommit[],
    message: string,
  ): Promise<string> {
    const baseTree = await this.getCommitTree(owner, repo, parentSha)

    const tree = await this.#request<{ sha: string }>('POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTree,
      tree: files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        content: file.content,
      })),
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
