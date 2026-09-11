import PostalMime, { type Email } from 'postal-mime'
import { createDraftPost } from '../../core/createDraftPost.ts'
import { GitHubClient, GitHubError } from '../../core/github.ts'
import { emailToPost } from '../../core/emailToPost.ts'
import type { InboundAttachment } from '../../core/attachments.ts'
import { authorFileForSender } from '../../core/sites.ts'
import type { DraftPostRequest } from '../../core/types.ts'
import {
  ConfigError,
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
        attachments: toInboundAttachments(email.attachments),
      },
      {
        ...(site.assets ? { assets: site.assets } : {}),
        policy: {
          allowedSenders: secrets.allowedSenders,
          subjectToken: secrets.subjectToken,
          requireAuthResults: env.REQUIRE_AUTH_RESULTS !== 'false',
        },
        stripSignature: env.STRIP_SIGNATURE !== 'false',
        draft: env.POST_AS_DRAFT === 'true',
      },
    )

    if (!decision.ok) {
      console.error(`Rejected inbound email for ${site.key}: ${decision.reason}`)
      // An authentication failure stays generic: naming the check that failed
      // tells someone probing the system what to try next. A content failure
      // has already cleared authentication, so there is nobody to withhold
      // from, and the sender needs to know what to fix.
      message.setReject(bounceMessage(decision.senderMessage))
      return
    }

    for (const rejected of decision.rejectedAttachments) {
      // The post is still created; the sender is told which files did not make
      // it, since a silently dropped photo is worse than a noisy one.
      console.warn(`Attachment not committed for ${site.key}: ${rejected.filename} — ${rejected.reason}`)
    }

    if (decision.viaSubjectToken) {
      // Not an error, but worth noticing: SPF/DKIM did not vouch for this
      // message, so the shared secret is all that authenticated it.
      console.warn('Message admitted by subject token; SPF/DKIM did not pass')
    }

    // A site may map specific senders to their own author page.
    const authorFile = authorFileForSender(site, decision.request.author)

    try {
      const result = await createDraftPost(
        { ...decision.request, ...(authorFile ? { authorFile } : {}) },
        site,
        githubClient(secrets.githubToken),
      )
      console.log(
        `Created draft PR #${result.pullRequestNumber} on ${site.key}: ${result.pullRequestUrl}`,
      )
    } catch (error) {
      // Without this, an authenticated message that fails at the GitHub step
      // throws out of the handler: Email Routing reports a worker exception,
      // the sender gets no bounce, and the post is silently lost. Rejecting
      // instead means the sender is told the message did not land.
      const failure = describeGitHubFailure(error)
      console.error(`Failed to create post for ${site.key}: ${failure}`)
      // The sender is authenticated, so say that the post did not land. The
      // detail stays in our logs: a GitHub error can name private repos and
      // is not the sender's problem to read.
      message.setReject(
        bounceMessage('the message was accepted but the post could not be created — the site owner has the details'),
      )
    }
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

    // The HTTPS caller may name an author; the site's map resolves it the same
    // way it does for an email sender. Unlike email, the address here is not
    // authenticated by DKIM — the bearer token is what authorises the request,
    // so `author` is a claim about attribution rather than an identity.
    const authorFile = authorFileForSender(target.site, parsed.request.author)

    try {
      const result = await createDraftPost(
        { ...parsed.request, ...(authorFile ? { authorFile } : {}) },
        target.site,
        githubClient(target.secrets.githubToken),
      )
      return json(result, 201)
    } catch (error) {
      console.error(`Failed to create post for ${target.site.key}: ${describeGitHubFailure(error)}`)
      return json({ error: 'Failed to create draft post' }, 502)
    }
  },
}

/**
 * Reshape `postal-mime` attachments into the core's shape.
 *
 * `content` is a union — an ArrayBuffer, a Uint8Array, or a string when the
 * part decoded as text — so each case is normalised to bytes rather than
 * assumed. A part with no filename is skipped: it cannot be matched to a
 * mention in the body, and is usually an inline signature image rather than
 * something the author meant to attach.
 */
function toInboundAttachments(attachments: Email['attachments']): InboundAttachment[] {
  const inbound: InboundAttachment[] = []

  for (const attachment of attachments) {
    if (!attachment.filename) continue

    let bytes: Uint8Array
    if (typeof attachment.content === 'string') {
      bytes = new TextEncoder().encode(attachment.content)
    } else if (attachment.content instanceof Uint8Array) {
      bytes = attachment.content
    } else {
      bytes = new Uint8Array(attachment.content)
    }

    inbound.push({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      bytes,
      // RFC 2387 multipart/related membership: how a client marks an image
      // embedded in the body. Not `disposition`, which reads "attachment" for
      // embedded and attached parts alike.
      ...(attachment.related ? { related: true } : {}),
    })
  }

  return inbound
}

/**
 * Build the text a rejected sender sees.
 *
 * Cloudflare puts this in the SMTP rejection, which the sending mail server
 * turns into a bounce. Kept short and on one line: it travels through other
 * people's software, and a long or multi-line reason may be truncated.
 */
function bounceMessage(senderMessage?: string): string {
  if (!senderMessage) return 'Message rejected'
  return `Message rejected: ${senderMessage}`
}

/**
 * Turn a GitHub failure into something actionable in the logs.
 *
 * A 404 from the git data API usually means the token cannot see the repo
 * rather than that the ref is missing — GitHub answers 404 instead of 403 so
 * as not to confirm a private repo exists. That distinction is worth spelling
 * out, because "not found" sends you looking for a missing branch when the
 * real problem is token scope.
 */
function describeGitHubFailure(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 404) {
      return `${error.message} — the GitHub token probably cannot access this repository (GitHub answers 404, not 403, for repositories a token cannot see). Check the token's repository access.`
    }
    if (error.status === 403) {
      return `${error.message} — the token reached the repository but lacks a required permission (Contents and Pull requests both need read/write).`
    }
    if (error.status === 401) {
      return `${error.message} — the token is invalid or expired.`
    }
    return `${error.message}: ${error.body.slice(0, 200)}`
  }
  return String(error)
}

/**
 * A GitHub client for one site.
 *
 * Per-site rather than global: the token comes from that site's resolved
 * secrets, so a credential scoped to one repo cannot reach the others.
 */
function githubClient(token: string): GitHubClient {
  return new GitHubClient({ token, userAgent: 'post-inbox' })
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
