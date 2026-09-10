import PostalMime from 'postal-mime'
import { createDraftPost } from '../../core/createDraftPost.ts'
import { GitHubClient } from '../../core/github.ts'
import { emailToPost } from '../../core/emailToPost.ts'
import { authorFileForSender } from '../../core/sites.ts'
import type { DraftPostRequest } from '../../core/types.ts'
import {
  ConfigError,
  requiredGlobal,
  siteForInboundAddress,
  siteForRequestKey,
  SITES,
  type Env,
} from './config.ts'

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
    // The destination address selects the site. `message.to` is the envelope
    // recipient, which is what Email Routing actually delivered to — not a
    // header a sender could have written.
    let target: ReturnType<typeof siteForInboundAddress>
    try {
      target = siteForInboundAddress(message.to, env)
    } catch (error) {
      console.error(`Rejected inbound email: ${String(error)}`)
      message.setReject('Message rejected')
      return
    }
    const { site, secrets } = target

    const email = await PostalMime.parse(message.raw)

    const decision = emailToPost(
      {
        // The envelope sender, not the `From:` header — the header is
        // trivially forgeable and is not what the platform authenticated.
        envelopeFrom: message.from,
        subject: message.headers.get('subject') ?? '',
        authenticationResults: message.headers.get('authentication-results'),
        arcAuthenticationResults: message.headers.get('arc-authentication-results'),
        text: email.text,
        date: email.date ? new Date(email.date) : null,
      },
      {
        policy: {
          allowedSenders: secrets.allowedSenders,
          subjectToken: env.EMAIL_SUBJECT_TOKEN ?? '',
          requireAuthResults: env.REQUIRE_AUTH_RESULTS !== 'false',
        },
        stripSignature: env.STRIP_SIGNATURE !== 'false',
        draft: env.POST_AS_DRAFT === 'true',
      },
    )

    if (!decision.ok) {
      // Logged for us; the sender only ever sees a generic rejection.
      console.error(`Rejected inbound email for ${site.key}: ${decision.reason}`)
      message.setReject('Message rejected')
      return
    }

    if (decision.viaSubjectToken) {
      // Not an error, but worth noticing: SPF/DKIM did not vouch for this
      // message, so the shared secret is all that authenticated it.
      console.warn('Message admitted by subject token; SPF/DKIM did not pass')
    }

    // A site may map specific senders to their own author page.
    const authorFile = authorFileForSender(site, decision.request.author)

    const result = await createDraftPost(
      { ...decision.request, ...(authorFile ? { authorFile } : {}) },
      site,
      githubClient(env),
    )
    console.log(`Created draft PR #${result.pullRequestNumber} on ${site.key}: ${result.pullRequestUrl}`)
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405)
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

    // Which site to post to. A single configured site is the default, so the
    // common case needs no `site` field.
    //
    // Every failure from here to the token check answers with a bare 401.
    // An unauthenticated caller learns nothing — not which site keys exist,
    // not whether the one they named is real, and not whether it has a token
    // configured. Listing the keys here would hand them over for free.
    const key = parsed.site ?? (SITES.length === 1 ? SITES[0]!.key : undefined)
    if (!key) {
      console.error('Rejected request: no `site` given and several are configured')
      return json({ error: 'Unauthorized' }, 401)
    }

    let target: ReturnType<typeof siteForRequestKey>
    try {
      target = siteForRequestKey(key, env)
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message)
        return json({ error: 'Unauthorized' }, 401)
      }
      throw error
    }

    if (!target.secrets.apiToken || !hasValidBearerToken(request, target.secrets.apiToken)) {
      return json({ error: 'Unauthorized' }, 401)
    }

    try {
      const result = await createDraftPost(parsed.request, target.site, githubClient(env))
      return json(result, 201)
    } catch (error) {
      console.error('Failed to create draft post', error)
      return json({ error: 'Failed to create draft post' }, 502)
    }
  },
}

function githubClient(env: Env): GitHubClient {
  return new GitHubClient({ token: requiredGlobal(env, 'GITHUB_TOKEN'), userAgent: 'post-inbox' })
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
): { request: DraftPostRequest; site?: string } | { error: string } {
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

  if (body.draft !== undefined && typeof body.draft !== 'boolean') {
    return { error: '`draft` must be a boolean' }
  }

  if (body.site !== undefined && typeof body.site !== 'string') {
    return { error: '`site` must be a string' }
  }

  return {
    ...(typeof body.site === 'string' ? { site: body.site } : {}),
    request: {
      title,
      body: text,
      date,
      author: typeof body.author === 'string' ? body.author : 'api',
      ...(tags ? { tags } : {}),
      ...(summary ? { summary } : {}),
      ...(body.draft === true ? { draft: true } : {}),
    },
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
