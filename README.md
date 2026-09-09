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
trivially forgeable. Two independent factors are available:

1. **The strong pair** — the envelope sender must be on your allowlist, *and*
   the receiving mail server's SPF/DKIM verdicts must pass (at least one of
   SPF or DKIM, with no DMARC failure). A forged sender fails this: an
   attacker cannot produce your domain's DKIM signature.

2. **A shared secret in the subject line**, written as `[token]` and stripped
   out before the subject becomes the post title.

**The token is only required when the strong pair cannot carry the message** —
no allowlist configured, verdict checking disabled, or verdicts that did not
actually pass. When SPF/DKIM pass and you are on the allowlist, just write a
normal subject line. If you do supply a token it must still be correct, so a
stale one fails loudly rather than being ignored.

The two can never both be absent. Disabling verdict checking makes the token
mandatory; having no token configured means a message without passing
verdicts is simply rejected.

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
npx wrangler secret put ALLOWED_SENDERS
npx wrangler secret put API_TOKEN

# Optional — only needed as a fallback when SPF/DKIM cannot vouch for a
# message. Set it if you disable verdict checking, or if your mail arrives
# without verdicts.
npx wrangler secret put EMAIL_SUBJECT_TOKEN
```

Generate tokens with `openssl rand -hex 24`. `ALLOWED_SENDERS` is a
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

Mail the routing address with the subject as your post title:

```
Subject: My New Post

The body is markdown, passed through as you wrote it.
Bare URLs like https://example.com get wrapped into links.
```

If your mail does not carry passing SPF/DKIM verdicts, add the shared secret
in brackets — `Subject: My New Post [your-subject-token]`.

### By HTTPS

```bash
curl -X POST https://post-inbox.<subdomain>.workers.dev \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"My New Post","body":"Hello.","tags":["Personal"]}'
```

`title` and `body` are required; `date`, `tags`, and `summary` are optional.

### Markdown, and what MDX does to it

Posts are committed as `.mdx`, but what you write in an email is markdown.
MDX reads `<` as the start of a JSX tag and `{` as a JavaScript expression, so
prose like `Array<int>`, `x <5`, or `{maybe}` is a **build error**, not text —
a `<https://example.com>` autolink is enough to fail the site build.

So `<`, `{` and `}` are escaped before committing, and `<url>` / `<user@host>`
autolinks are converted to real markdown links. Code — fenced blocks and
inline backticks — is left alone, and so is ordinary prose: headings, lists,
tables, emphasis, task lists, footnotes, quotes and unicode all pass through
untouched.

Two consequences worth knowing:

- **Raw HTML in the body will not render.** `<b>bold</b>` comes out as visible
  angle brackets. Use `**bold**`.
- **An unbalanced backtick can still break the build.** An odd number of
  backticks makes the code-span detection read the rest of the line as code
  and skip escaping it. Balance your backticks.

### Acceptance test

`examples/acceptance-test/` is the canonical check: **send that email, get a
draft PR that builds.** Its `body.md` exercises every supported feature, and
`expected.mdx` records exactly what the pipeline should produce — `pnpm test`
diffs against it, so most regressions are caught without sending anything.

Run the email version after changing the transformation, upgrading the site
template, or setting this up for a new site. See
`examples/acceptance-test/README.md`.

The site repo should also validate this in CI, since a post can reach it
without going through post-inbox at all — the web editor, or a direct push.

### Email signatures

A signature delimited by the standard `-- ` line is stripped from the body.
Only that delimiter is recognised — nothing tries to guess at signatures by
shape, because a wrong guess eats part of your post. If yours does not
conform, set `STRIP_SIGNATURE=false` and trim it yourself:

```bash
npx wrangler secret put STRIP_SIGNATURE   # or set it in wrangler.jsonc vars
```

## Roadmap

**POC (here):** one site, one sender, plaintext body, email + HTTPS paths.
Known gap: there is no way to set tags from an email. See `STATUS.md`.

**MVP:** multi-site and multi-user config, GitHub App instead of a PAT,
Cloudflare rate limiting, and per-user allowlists.

**Post-MVP:** attachments — images and PDFs committed into the repo, with a
MIME allowlist and a size cap. HEIC conversion and resizing are their own
problem, likely a GitHub Action on the PR rather than in the Worker
(`sharp` needs native binaries a Worker cannot run).

## License

MIT
