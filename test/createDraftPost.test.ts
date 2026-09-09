import { describe, expect, it } from 'vitest'
import { createDraftPost } from '../src/core/createDraftPost.ts'
import { GitHubClient } from '../src/core/github.ts'
import type { SiteConfig } from '../src/core/types.ts'

const site: SiteConfig = {
  owner: 'TeamNickHart',
  repo: 'your-blog',
  baseBranch: 'main',
  contentPath: 'data/blog',
  extension: '.mdx',
}

const request = {
  title: 'Hello From Email',
  body: 'Body text.',
  date: new Date('2026-09-09T12:00:00Z'),
  author: 'nick@example.com',
}

/**
 * A GitHub stand-in that records requests, so we can assert on the shape
 * of the commit and PR without touching the network.
 */
function fakeGitHub(options: { existingBranches?: string[] } = {}) {
  const existing = new Set(options.existingBranches ?? ['main'])
  const calls: { method: string; path: string; body: unknown }[] = []

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })

    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

    const refMatch = /\/git\/ref\/heads\/(.+)$/.exec(path)
    if (method === 'GET' && refMatch) {
      const branch = decodeURIComponent(refMatch[1]!)
      return existing.has(branch)
        ? json({ object: { sha: 'base-commit-sha' } })
        : json({ message: 'Not Found' }, 404)
    }
    if (method === 'GET' && path.includes('/git/commits/')) {
      return json({ tree: { sha: 'base-tree-sha' } })
    }
    if (method === 'POST' && path.endsWith('/git/trees')) return json({ sha: 'new-tree-sha' })
    if (method === 'POST' && path.endsWith('/git/commits')) return json({ sha: 'new-commit-sha' })
    if (method === 'POST' && path.endsWith('/git/refs')) {
      existing.add(String(body.ref).replace('refs/heads/', ''))
      return json({}, 201)
    }
    if (method === 'POST' && path.endsWith('/pulls')) {
      return json({ number: 42, html_url: 'https://github.com/your-org/your-blog/pull/42' }, 201)
    }
    throw new Error(`Unexpected request: ${method} ${path}`)
  }) as unknown as typeof fetch

  return { client: new GitHubClient({ token: 't', fetch: fetchImpl }), calls }
}

describe('createDraftPost', () => {
  it('commits the post and opens a PR', async () => {
    const { client, calls } = fakeGitHub()
    const result = await createDraftPost(request, site, client)

    expect(result).toMatchObject({
      branch: 'post-inbox/2026-09-09-hello-from-email',
      path: 'data/blog/hello-from-email.mdx',
      commitSha: 'new-commit-sha',
      pullRequestNumber: 42,
    })

    const tree = calls.find((call) => call.path.endsWith('/git/trees'))!.body as {
      base_tree: string
      tree: { path: string; content: string; mode: string }[]
    }
    expect(tree.base_tree).toBe('base-tree-sha')
    expect(tree.tree).toHaveLength(1)
    expect(tree.tree[0]!.path).toBe('data/blog/hello-from-email.mdx')
    expect(tree.tree[0]!.content).toContain('draft: true')
    expect(tree.tree[0]!.content).toContain("title: 'Hello From Email'")
  })

  it('opens the PR against the configured base branch, never publishing directly', async () => {
    const { client, calls } = fakeGitHub()
    await createDraftPost(request, site, client)

    const pull = calls.find((call) => call.path.endsWith('/pulls'))!.body as Record<string, string>
    expect(pull.base).toBe('main')
    expect(pull.head).toBe('post-inbox/2026-09-09-hello-from-email')
    expect(pull.title).toBe('Draft: Hello From Email')
  })

  it('picks a fresh branch name when one is already taken', async () => {
    const { client } = fakeGitHub({
      existingBranches: ['main', 'post-inbox/2026-09-09-hello-from-email'],
    })
    const result = await createDraftPost(request, site, client)
    expect(result.branch).toBe('post-inbox/2026-09-09-hello-from-email-2')
  })
})
