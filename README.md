# post-inbox

Turn an email into a draft blog post — as a branch, a commit, and a pull
request with a live preview. Never published directly.

Send an email (or an HTTPS POST from a Shortcut) and a PR shows up on your
blog repo with the post committed on its own branch. You review the preview
deploy and merge when you are happy with it.

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

### 2. Configure your sites

Copy the example and edit it:

```bash
cp sites.example.jsonc sites.jsonc
```

`sites.jsonc` is **gitignored** — it names the addresses that accept mail and
the repos that get written to, and this repo is public. Keep real values out of
anything committed, including docs and tests: use `example.com` placeholders.

Each site needs a `key` (lowercase, it becomes an environment-variable prefix),
one or more `inboundAddresses`, and the repo to write to. For the Tailwind
Nextjs Starter Blog, `contentPath` is `data/blog` and `extension` is `.mdx`.

**Pick an unguessable inbound address.** `draft@yourdomain.com` will be found by
address-harvesting bots, and every junk message wakes the Worker and fills the
logs with rejections:

```bash
pnpm generate:address yourdomain.com
```

This is noise reduction, not access control — the sender allowlist and DKIM
checks are what stop a stranger posting, and an address that leaks costs you
nothing but a rotation.

### 3. Set secrets

Two guided commands. Global secrets first:

```bash
pnpm configure
```

That prompts for `GITHUB_TOKEN` (not echoed) and offers to generate an optional
`EMAIL_SUBJECT_TOKEN`. Then once per site:

```bash
pnpm configure:site mysite
```

That sets `MYSITE_ALLOWED_SENDERS` — who may post, a real access control — and
offers to generate `MYSITE_API_TOKEN` for the HTTPS path. Both commands ask
before replacing a secret that is already set.

Generated tokens are piped straight into `wrangler secret put`, so they never
reach your clipboard or shell history. The two that you have to use elsewhere —
the subject token and the API token — are printed once; save them then, because
Cloudflare cannot read a secret back.

To do it by hand instead:

```bash
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put MYSITE_ALLOWED_SENDERS   # comma- or space-separated
npx wrangler secret put MYSITE_API_TOKEN         # HTTPS path, optional
npx wrangler secret put EMAIL_SUBJECT_TOKEN      # optional fallback

# Optional per-site overrides of the two globals
npx wrangler secret put MYSITE_GITHUB_TOKEN
npx wrangler secret put MYSITE_EMAIL_SUBJECT_TOKEN
```

#### Global versus per-site tokens

`GITHUB_TOKEN` and `EMAIL_SUBJECT_TOKEN` are **defaults**. Any site may override
either with its own:

| Secret | Effect |
|---|---|
| `MYSITE_GITHUB_TOKEN` | This site writes with its own credential |
| `MYSITE_EMAIL_SUBJECT_TOKEN` | This site accepts its own subject secret |

A per-site GitHub token is the better setup once you have more than one site: a
credential scoped to one repo cannot reach the others, so a leak is contained.
The global token has to reach every repo it is the default for — and its
resource owner must be the **org**, not a personal account, or the other repos
answer 404 rather than 403.

Both fall back to the global value, so this is incremental: an existing
deployment with only the globals keeps working, and sites can move across one
at a time. `pnpm configure:site <key>` offers both.

### 4. Deploy

```bash
pnpm deploy
```

This compiles `sites.jsonc` into the bundle and deploys. A malformed config
fails here rather than when an email arrives.

### 5. Wire up email

In the Cloudflare dashboard, on a domain you control:

1. **Email → Email Routing**, and enable it. Cloudflare adds the MX and
   SPF records for you.
2. **Email Routing → Routing rules → Create address.** Pick the address
   you will mail posts to, e.g. `post@yourdomain.com`.
3. Set its action to **Send to a Worker** and choose `post-inbox`.

Repeat per site. The address the mail was sent *to* is what selects the site,
so each site needs its own address.

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

#### Tags and summary

Set frontmatter the subject line cannot carry with a `Key: value` block at the
very top of the body:

```
Tags: Coding, iOS, job application
Summary: What I learned shipping this.

The post body starts here.
```

Only `Tags` and `Summary` are recognised, and only as a contiguous block at the
start — the first line that is not one of them ends the block, so prose
containing a colon is never mistaken for metadata. An unrecognised key is left
in the body rather than silently dropped.

Tags split on commas only, so a tag may contain spaces (`job application`), and
case is preserved (`IKEA`, `SwiftLint`) to match the tags a site already uses.

### By HTTPS

```bash
curl -X POST https://post-inbox.<subdomain>.workers.dev \
  -H "Authorization: Bearer $MYSITE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site":"mysite","title":"My New Post","body":"Hello.","tags":["Personal"]}'
```

`title` and `body` are required. `site` names which site to post to, and may be
omitted when only one is configured. `date`, `tags`, `summary` and `draft` are
optional. The bearer token is the one for that site.

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

### Drafts and previews

Posts are committed with `draft: false`, and the pull request is what stops
them going live. That is deliberate: the Tailwind Nextjs Starter Blog excludes
drafts from production builds, and a Vercel preview *is* a production build, so
a `draft: true` post returns 404 on the very preview meant for reviewing it.

Nothing is published by the post existing — it is on a branch, nothing links to
it, and merging is an explicit act.

Set `POST_AS_DRAFT=true` if you would rather merge posts to your main branch
unpublished and flip the flag in a separate commit later. Expect the preview to
404 in that case; check the diff instead. The HTTPS path can also pass
`"draft": true` per request.

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
