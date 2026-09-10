# Status

**Where things stand: the POC works end to end, on both paths, against the
real blog repo.**

Last updated 2026-09-09.

## Working

| Thing | State |
|---|---|
| HTTPS POST → draft PR | Working — verified end to end |
| Email → draft PR | Working — verified end to end |
| Sender allowlist | Working — a non-allowlisted sender is rejected |
| Subject token | Now a conditional fallback — only required when SPF/DKIM cannot vouch for the message |
| SPF/DKIM verdict check | Working — Gmail-sent mail arrives with passing verdicts |
| Bearer-token auth on HTTPS | Working — 401 with no token, wrong token, and 405 on GET |
| Vercel preview on the PR | Passing — a generated post does not break the site build |
| Email signature stripping | Working — verified in production |
| MDX escaping | Working — a markdown body is made safe to compile as MDX |
| Tags and summary from email | Working — a `Tags:`/`Summary:` block at the top of the body |
| Multiple senders per site | Working — comma- or space-separated |
| Multi-site config | Working — `sites.jsonc` plus per-site secrets, routed by inbound address |
| Guided setup | Working — `pnpm configure` and `pnpm configure:site <key>` |
| Tests | 147 passing |

Deployed as the `post-inbox` Worker, version `89d8adf7`, with one inbound
address per site via Cloudflare Email Routing.

**This repo is public**, so the real inbound addresses, Worker hostname and
repo mappings live in `sites.jsonc`, which is gitignored. See
`sites.example.jsonc`, and use `example.com` placeholders in anything
committed.

Posts land in each site's `data/blog` as `.mdx` on a
`post-inbox/<date>-<slug>` branch, committed with `draft: false` — see below.

## Confirmed by building it, not assumed

- **Frontmatter**: single-quoted YAML scalars, `tags` as an array. Matches
  the existing posts.
- **`draft: true` hides a post from its own preview.** The starter's slug page
  filters drafts out of `allBlogs` and returns `notFound()`, so the post has no
  page at all on a Vercel preview — not merely no listing entry. Posts are
  therefore committed with `draft: false`; the PR is the gate.
- **`authors` is omitted**, not set. `data/authors/` contains only
  `default.mdx` and no existing post sets `authors:` — emitting an unknown
  author key would reference a nonexistent file and break the build. The
  field is only written when a real author file is resolved.
- **SPF/DKIM verdicts do arrive.** The design doc's central security check
  works as written. This was expected to fail
  ([workerd#6740](https://github.com/cloudflare/workerd/issues/6740) reports
  Email Workers receiving `arc=none` with no verdicts) — it did not, so
  `REQUIRE_AUTH_RESULTS` can stay on. The fail-closed default costs nothing.
- **Node 24**, not 20. Node 20 is EOL and outside Wrangler's supported range.

## Known issues

- **HTML-only email is rejected** with the same generic bounce as a security
  failure, so the reason is invisible to the sender. Most clients send a
  plaintext part alongside the HTML, so this is an edge case. Converting HTML
  to markdown (`turndown`) is a real feature, not yet built.
- **Raw HTML in a post body does not render** — a deliberate consequence of
  MDX escaping. See the README.
- **`POST_AS_DRAFT=true` makes the post 404 on the Vercel preview.** That is
  the template's behaviour, not a bug here: contentlayer drops drafts from
  production builds and a preview build is a production build. Left as an
  option because merging unpublished is a legitimate workflow.
- **An unbalanced backtick can still produce a body that fails to build.**

`examples/acceptance-test/` is the canonical acceptance test — send that
email, get a draft PR that builds. `pnpm test` diffs the pipeline against the
recorded `expected.mdx`; `pnpm test:accept` regenerates it after a deliberate
change.
- **Test PRs are open** on the blog repo, with branches, from verification runs.
- **`weishart`'s allowlist was set to one malformed entry** — two addresses
  space-separated became a single string, back when the configure script split
  on commas only. Re-run `pnpm configure:site weishart`; the Worker now refuses
  such a value loudly rather than matching nothing.
- **The obsolete flat `ALLOWED_SENDERS` and `API_TOKEN` secrets are still set**
  on the Worker and unused by the code. Delete them with
  `npx wrangler secret delete <name>`.

## Not built yet

Scoped out of the POC deliberately — see `post-inbox-design.md`.

**Blog-repo CI (separate task):** a shared reusable GitHub Actions workflow
across all three site repos — MDX compile check and frontmatter validation as
blocking checks, tag linting and spellcheck as advisory. Needed because a post
can reach a repo without passing through post-inbox. See §11 of the design
doc.

**MVP, remaining:** a GitHub App instead of a fine-grained PAT, Cloudflare
rate limiting, and hashing the per-site API tokens rather than comparing them
in plaintext.

**Backlog: per-site GitHub and subject tokens.** Both are global today, so one
GitHub credential writes to every configured repo and one subject token covers
every site. Per-site versions would mean a leaked token reaches one blog rather
than all of them. Deliberately deferred: the GitHub App supersedes the PAT and
scopes per-repo properly, and three PATs to create and rotate is real friction
for a marginal gain. `pnpm configure` sets the global ones and
`pnpm configure:site <key>` the per-site ones, so the split already exists in
the tooling.

**Backlog:** per-sender author mapping. The `authorsBySender` field exists in
the site schema and `authorFileForSender` resolves it, so mapping a family
member's address to their own author page is a config change — but no site
populates it yet, and it has not been exercised end to end.

**Post-MVP:** attachments — images and PDFs committed to the repo, MIME
allowlist, size cap. HEIC conversion and resizing are a separate problem,
likely a GitHub Action on the PR rather than in the Worker.

## Notes for future me

- The GitHub PAT is fine-grained, scoped to `your-blog` only, with
  Contents + Pull requests read/write. **It expires** — when posting starts
  failing with a 502, check this first.
- `pnpm deploy` does not work: pnpm reserves `deploy` as a builtin. Use
  `pnpm run deploy`.
- `wrangler tail` shows live traffic only. To see why an email was rejected,
  start the tail and *then* send the mail. Rejection reasons are logged;
  the sender only ever sees a generic `555 Message rejected`.
- **This repo is public.** Never commit real inbound addresses, the Worker
  hostname, or repo mappings — use `example.com` placeholders. Git history was
  rewritten once (`git filter-repo --replace-text`) to purge a real address
  and Worker URL that reached `STATUS.md`; a force-push followed.
  `pnpm check:secrets` now blocks the obvious cases, including `git add -f`.
- The Workers runtime rejects a detached native `fetch` with
  "Illegal invocation". `GitHubClient` binds it to `globalThis` for this
  reason; a test injecting a plain function will not catch a regression here.
