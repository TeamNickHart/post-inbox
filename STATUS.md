# Status

**Where things stand: the POC works end to end, on both paths, against the
real blog repo.**

Last updated 2026-09-09.

## Working

| Thing | State |
|---|---|
| HTTPS POST → draft PR | Working — verified, [PR #7](https://github.com/your-org/your-blog/pull/7) |
| Email → draft PR | Working — verified, [PR #8](https://github.com/your-org/your-blog/pull/8) |
| Sender allowlist | Working — a non-allowlisted sender is rejected |
| Subject-token second factor | Working — verified by a rejection with the wrong token |
| SPF/DKIM verdict check | Working — Gmail-sent mail arrives with passing verdicts |
| Bearer-token auth on HTTPS | Working — 401 with no token, wrong token, and 405 on GET |
| Vercel preview on the PR | Passing — a generated post does not break the site build |
| Email signature stripping | Working — verified in production, [PR #9](https://github.com/your-org/your-blog/pull/9) |
| Tests | 56 passing |

Deployed as `post-inbox` at `https://post-inbox.example.workers.dev`,
version `32952d03`. Inbound address is `draft@example.com` via Cloudflare
Email Routing.

Target repo is `your-org/your-blog`, posts land in `data/blog` as
`.mdx` with `draft: true`, on a `post-inbox/<date>-<slug>` branch.

## Confirmed by building it, not assumed

- **Frontmatter**: single-quoted YAML scalars, `tags` as an array. Matches
  the existing posts.
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

- **No way to set tags from an email.** Posts arrive with `tags: []` and need
  manual editing. Undecided between a `Tags:` line in the body and trailing
  hashtags.
- **Test PRs #7, #8 and #9 are open** on the blog repo, with branches.

## Not built yet

Scoped out of the POC deliberately — see `post-inbox-design.md`.

**MVP:** multi-site and multi-user config (users × sites, token hashes not
plaintext, per-user author mapping), a GitHub App instead of a fine-grained
PAT, Cloudflare rate limiting.

**Post-MVP:** attachments — images and PDFs committed to the repo, MIME
allowlist, size cap. HEIC conversion and resizing are a separate problem,
likely a GitHub Action on the PR rather than in the Worker.

## Notes for future me

- The GitHub PAT is fine-grained, scoped to `your-blog` only, with
  Contents + Pull requests read/write. **It expires** — when posting starts
  failing with a 502, check this first.
- `wrangler tail` shows live traffic only. To see why an email was rejected,
  start the tail and *then* send the mail. Rejection reasons are logged;
  the sender only ever sees a generic `555 Message rejected`.
- The Workers runtime rejects a detached native `fetch` with
  "Illegal invocation". `GitHubClient` binds it to `globalThis` for this
  reason; a test injecting a plain function will not catch a regression here.
