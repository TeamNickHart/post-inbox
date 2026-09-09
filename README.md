# post-inbox

Turn an email into a draft blog post — as a branch, a commit, and a pull
request with a live preview. Never published directly.

Send an email (or an HTTPS POST from a Shortcut) and a PR shows up on your
blog repo with the post committed as `draft: true`. You review the preview
deploy, flip `draft` to `false`, and merge.

**Status: proof of concept.** Single site, single sender, plaintext bodies,
no attachments. See [Roadmap](#roadmap).

## How it works

```
Email → Cloudflare Email Routing → Worker (email handler)  ─┐
                                                            ├─→ createDraftPost() → GitHub API → branch + commit + PR
Shortcut / curl → HTTPS POST → Worker (fetch handler)      ─┘
```

Two entry points, one shared core function. `src/core/` is plain
host-agnostic TypeScript with no Cloudflare in it — the runtime and the
email platform are thin adapters around it, so porting to Vercel Functions
or Postmark means rewriting only `src/adapters/`.

| Path | Role |
|---|---|
| `src/core/createDraftPost.ts` | The one function both entry points call |
| `src/core/markdown.ts` | Slug, frontmatter, bare-URL linkifying |
| `src/core/senderAuth.ts` | SPF/DKIM verdicts + sender allowlist + subject token |
| `src/core/github.ts` | The only code that talks to GitHub |
| `src/adapters/cloudflare/` | Worker `email` and `fetch` handlers |

## Security

The HTTPS path takes a bearer token. Straightforward.

The email path is the interesting one, because a `From:` header is
trivially forgeable. Three checks, all of which must pass:

1. **Envelope sender allowlist** — the address must be one you configured.
2. **A shared secret in the subject line**, written as `[token]` and
   stripped out before the subject becomes the post title.
3. **SPF/DKIM verdicts** from the receiving mail server, requiring a pass
   from at least one of SPF or DKIM and no DMARC failure.

> **Note on check 3:** this check is known to be fragile on Cloudflare.
> [cloudflare/workerd#6740](https://github.com/cloudflare/workerd/issues/6740)
> reports mail reaching an Email Worker with no `Authentication-Results`
> header and `ARC-Authentication-Results` as `arc=none` — no verdicts at
> all. In practice, mail sent from Gmail to a Cloudflare Email Routing
> address *does* arrive with passing verdicts, so the check works. If yours
> does not, this code **fails closed** and rejects the message rather than
> waving it through. Setting `REQUIRE_AUTH_RESULTS=false` drops to checks 1
> and 2 only — a real downgrade, since the subject token becomes the only
> thing an attacker who forges your address has to guess. Survivable here
> because the worst case is an unwanted draft PR, never a published post.

Nothing sensitive is committed: all credentials, the sender allowlist, and
the subject token are Wrangler secrets. See `.dev.vars.example`.

## Setup

Requires **Node 24+** (`nvm use`).

```bash
pnpm install
pnpm test
```

### 1. GitHub credentials

For the POC, a fine-grained personal access token is enough. Scope it to
the single blog repo with **Contents: read/write** and **Pull requests:
read/write**. (A GitHub App installed on the org is the better answer for
the MVP, when multiple repos are in play.)

### 2. Configure the target repo

Non-secret settings live in `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "GITHUB_OWNER": "TeamNickHart",
  "GITHUB_REPO": "your-blog",
  "GITHUB_BASE_BRANCH": "main",
  "CONTENT_PATH": "data/blog",
  "CONTENT_EXTENSION": ".mdx"
}
```

### 3. Set secrets

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put EMAIL_SUBJECT_TOKEN
npx wrangler secret put ALLOWED_SENDERS
npx wrangler secret put API_TOKEN
```

Generate the two tokens with `openssl rand -hex 24`. `ALLOWED_SENDERS` is a
comma-separated list of addresses.

### 4. Deploy

```bash
npx wrangler deploy
```

### 5. Wire up email

In the Cloudflare dashboard, on a domain you control:

1. **Email → Email Routing**, and enable it. Cloudflare adds the MX and
   SPF records for you.
2. **Email Routing → Routing rules → Create address.** Pick the address
   you will mail posts to, e.g. `post@yourdomain.com`.
3. Set its action to **Send to a Worker** and choose `post-inbox`.

## Usage

### By email

Mail the routing address with the subject as your post title, plus the
shared secret in brackets:

```
Subject: My New Post [your-subject-token]

The body is markdown, passed through as you wrote it.
Bare URLs like https://example.com get wrapped into links.
```

### By HTTPS

```bash
curl -X POST https://post-inbox.<subdomain>.workers.dev \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"My New Post","body":"Hello.","tags":["Personal"]}'
```

`title` and `body` are required; `date`, `tags`, and `summary` are optional.

## Roadmap

**POC (here):** one site, one sender, plaintext body, email + HTTPS paths.
Known gaps: email signatures are not stripped from the body, and there is no
way to set tags from an email. See `STATUS.md`.

**MVP:** multi-site and multi-user config, GitHub App instead of a PAT,
Cloudflare rate limiting, and per-user allowlists.

**Post-MVP:** attachments — images and PDFs committed into the repo, with a
MIME allowlist and a size cap. HEIC conversion and resizing are their own
problem, likely a GitHub Action on the PR rather than in the Worker
(`sharp` needs native binaries a Worker cannot run).

## License

MIT
