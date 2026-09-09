import PostalMime from 'postal-mime'
import { createDraftPost } from '../../core/createDraftPost.ts'
import { GitHubClient } from '../../core/github.ts'
import { authenticateSender, extractSubjectToken } from '../../core/senderAuth.ts'
import { stripSignature } from '../../core/signature.ts'
import type { DraftPostRequest } from '../../core/types.ts'
import { senderAuthPolicyFromEnv, siteConfigFromEnv, type Env } from './config.ts'

/**
 * Cloudflare adapter: two entry points, one shared core call.
 *
 * This file is intentionally thin — it receives email or HTTP, decides
 * whether the caller is authorized, reshapes the input into a
 * `DraftPostRequest`, and hands off to `createDraftPost`. All the
 * transformation and GitHub logic lives in `src/core`, which knows
 * nothing about Cloudflare.
 */
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const subject = message.headers.get('subject') ?? ''

    const auth = authenticateSender(
      {
        envelopeFrom: message.from,
        authenticationResults: message.headers.get('authentication-results'),
        arcAuthenticationResults: message.headers.get('arc-authentication-results'),
        subject,
      },
      senderAuthPolicyFromEnv(env),
    )

    if (!auth.ok) {
      // Logged for us, but the rejection reason sent back to the sender is
      // deliberately generic.
      console.error(`Rejected inbound email: ${auth.reason}`)
      message.setReject('Message rejected')
      return
    }

    const email = await PostalMime.parse(message.raw)
    const { title } = extractSubjectToken(subject)
    if (!title) {
      console.error('Rejected inbound email: empty subject after removing token')
      message.setReject('Message rejected')
      return
    }

    // Plaintext only for now, per the POC scope. `email.text` is absent
    // for HTML-only mail, which we do not attempt to convert.
    const rawBody = email.text?.trim()
    const body =
      rawBody && env.STRIP_SIGNATURE !== 'false' ? stripSignature(rawBody).trim() : rawBody
    if (!body) {
      console.error('Rejected inbound email: no plaintext body')
      message.setReject('Message rejected')
      return
    }

    const request: DraftPostRequest = {
      title,
      body,
      date: email.date ? new Date(email.date) : new Date(),
      author: auth.sender,
    }

    const result = await createDraftPost(request, siteConfigFromEnv(env), githubClient(env))
    console.log(`Created draft PR #${result.pullRequestNumber}: ${result.pullRequestUrl}`)
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
    }

    if (!hasValidBearerToken(request, env.API_TOKEN)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ error: 'Invalid JSON body' }, 400)
    }

    const parsed = parsePostPayload(payload)
    if ('error' in parsed) {
      return json({ error: parsed.error }, 400)
    }

    try {
      const result = await createDraftPost(parsed.request, siteConfigFromEnv(env), githubClient(env))
      return json(result, 201)
    } catch (error) {
      console.error('Failed to create draft post', error)
      return json({ error: 'Failed to create draft post' }, 502)
    }
  },
}

function githubClient(env: Env): GitHubClient {
  return new GitHubClient({ token: env.GITHUB_TOKEN, userAgent: 'post-inbox' })
}

function hasValidBearerToken(request: Request, expected: string | undefined): boolean {
  if (!expected) return false
  const header = request.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false

  const provided = header.slice(prefix.length)
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

/** Validate and normalize the HTTPS payload. */
function parsePostPayload(
  payload: unknown,
): { request: DraftPostRequest } | { error: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { error: 'Body must be a JSON object' }
  }
  const body = payload as Record<string, unknown>

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return { error: '`title` is required' }

  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) return { error: '`body` is required' }

  let date = new Date()
  if (typeof body.date === 'string') {
    const parsed = new Date(body.date)
    if (Number.isNaN(parsed.getTime())) return { error: '`date` is not a valid date' }
    date = parsed
  }

  let tags: string[] | undefined
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      return { error: '`tags` must be an array of strings' }
    }
    tags = body.tags as string[]
  }

  const summary = typeof body.summary === 'string' ? body.summary.trim() : undefined

  return {
    request: {
      title,
      body: text,
      date,
      author: typeof body.author === 'string' ? body.author : 'api',
      ...(tags ? { tags } : {}),
      ...(summary ? { summary } : {}),
    },
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
