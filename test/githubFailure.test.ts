import { describe, expect, it } from 'vitest'
import { createDraftPost } from '../src/core/createDraftPost.ts'
import { GitHubClient, GitHubError } from '../src/core/github.ts'
import type { SiteConfig } from '../src/core/types.ts'

const site: SiteConfig = {
  owner: 'test-org',
  repo: 'unreachable-blog',
  baseBranch: 'main',
  contentPath: 'data/blog',
  extension: '.mdx',
}

const request = {
  title: 'A Post',
  body: 'Body.',
  date: new Date('2026-09-09T12:00:00Z'),
  author: 'someone@example.com',
}

function clientReturning(status: number, body = '{"message":"Not Found"}') {
  const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch
  return new GitHubClient({ token: 't', fetch: fetchImpl })
}

describe('a GitHub failure is surfaced, not swallowed', () => {
  it('throws a GitHubError carrying the status, so the caller can explain it', async () => {
    // A token scoped to the wrong repository gets 404, not 403: GitHub does
    // not confirm that a private repository exists. This is the failure that
    // silently dropped an authenticated email until the handler caught it.
    await expect(createDraftPost(request, site, clientReturning(404))).rejects.toMatchObject({
      name: 'GitHubError',
      status: 404,
    })
  })

  it('reports the repository and ref that could not be read', async () => {
    try {
      await createDraftPost(request, site, clientReturning(404))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as GitHubError).message).toContain('test-org/unreachable-blog')
      expect((error as GitHubError).message).toContain('heads/main')
    }
  })

  it('distinguishes a permission failure from an unreachable repository', async () => {
    await expect(createDraftPost(request, site, clientReturning(403))).rejects.toMatchObject({
      status: 403,
    })
  })

  it('distinguishes an expired token', async () => {
    await expect(createDraftPost(request, site, clientReturning(401))).rejects.toMatchObject({
      status: 401,
    })
  })

  it('keeps the response body, so an unexpected failure is still diagnosable', async () => {
    try {
      await createDraftPost(request, site, clientReturning(422, '{"message":"Reference exists"}'))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as GitHubError).body).toContain('Reference exists')
    }
  })
})
