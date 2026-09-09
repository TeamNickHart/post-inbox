import { describe, expect, it } from 'vitest'
import { GitHubClient, GitHubError } from '../src/core/github.ts'

/**
 * A fetch stand-in that, like the Workers runtime, refuses to run when
 * it has been detached from its global `this`.
 *
 * The Workers `fetch` throws "Illegal invocation" in exactly this case,
 * which a plain injected function does not — so without this guard the
 * test suite happily passes code that breaks in production.
 */
function strictGlobalFetch() {
  const holder = {
    fetch(this: unknown, _url: string | URL | Request, _init?: RequestInit): Promise<Response> {
      if (this !== holder) {
        return Promise.reject(
          new TypeError('Illegal invocation: function called with incorrect `this` reference.'),
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ object: { sha: 'abc123' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    },
  }
  return holder
}

describe('GitHubClient', () => {
  it('calls the global fetch without detaching it from its receiver', async () => {
    // Reproduces the Workers runtime behaviour: the real `fetch` throws
    // "Illegal invocation" when called as a method on another object, so
    // storing it and calling `this.#fetch(...)` fails in production while
    // an injected plain function would not.
    const original = globalThis.fetch
    let called = false
    try {
      const strict = function (this: unknown) {
        if (this !== globalThis && this !== undefined) {
          throw new TypeError('Illegal invocation: function called with incorrect `this` reference.')
        }
        called = true
        return Promise.resolve(
          new Response(JSON.stringify({ object: { sha: 'abc123' } }), { status: 200 }),
        )
      }
      Object.defineProperty(strict, 'name', { value: 'fetch' })
      globalThis.fetch = strict as unknown as typeof fetch

      // No `fetch` injected: the client must fall back to the global one.
      const client = new GitHubClient({ token: 't' })
      await expect(client.getBranchHead('o', 'r', 'main')).resolves.toBe('abc123')
      expect(called).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  it('does not detach an injected fetch from its receiver', async () => {
    const holder = strictGlobalFetch()
    const client = new GitHubClient({
      token: 't',
      fetch: holder.fetch.bind(holder) as unknown as typeof fetch,
    })

    await expect(client.getBranchHead('o', 'r', 'main')).resolves.toBe('abc123')
  })

  it('sends the headers GitHub requires', async () => {
    let seen: Headers | undefined
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ object: { sha: 'abc123' } }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new GitHubClient({ token: 'secret-token', fetch: fetchImpl })
    await client.getBranchHead('o', 'r', 'main')

    expect(seen?.get('authorization')).toBe('Bearer secret-token')
    expect(seen?.get('accept')).toBe('application/vnd.github+json')
    // GitHub rejects requests without a User-Agent.
    expect(seen?.get('user-agent')).toBe('post-inbox')
  })

  it('surfaces the status and body when GitHub rejects a call', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"Not Found"}', { status: 404 })) as unknown as typeof fetch

    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    await expect(client.getBranchHead('o', 'r', 'nope')).rejects.toThrow(GitHubError)
    await expect(client.getBranchHead('o', 'r', 'nope')).rejects.toMatchObject({ status: 404 })
  })

  it('reports a missing branch as absent rather than throwing', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    await expect(client.branchExists('o', 'r', 'nope')).resolves.toBe(false)
  })

  it('lets an unexpected error from branchExists propagate', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    await expect(client.branchExists('o', 'r', 'x')).rejects.toThrow(GitHubError)
  })

  it('encodes a branch name containing a slash', async () => {
    let url = ''
    const fetchImpl = (async (input: string | URL | Request) => {
      url = String(input)
      return new Response(JSON.stringify({ object: { sha: 'abc' } }), { status: 200 })
    }) as unknown as typeof fetch

    const client = new GitHubClient({ token: 't', fetch: fetchImpl })
    await client.getBranchHead('o', 'r', 'post-inbox/2026-09-09-x')
    expect(url).toContain('post-inbox%2F2026-09-09-x')
  })
})
