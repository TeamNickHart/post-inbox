# Status

**Working end to end on three real sites.** Email a site's address, get a pull
request with a building preview.

Last updated 2026-09-09. Worker version `50d25eb7`, 152 tests passing.

## What works

| | Verified by |
|---|---|
| Email → draft PR | A real email to each of the three sites |
| HTTPS POST → draft PR | `curl` against the deployed Worker |
| Routing by inbound address | Three emails, three different repos, no syntax to remember |
| Sender allowlist | A non-allowlisted sender is rejected |
| SPF/DKIM verdicts | Cloudflare's own activity log shows `pass` on real mail |
| Subject token fallback | Rejection with a wrong token; acceptance without one when DKIM passes |
| Bearer auth per site | 401 with no token, a wrong token, and an unknown site |
| Signature stripping | Byte-checked against a committed post |
| Markdown → MDX | Vercel previews build on all three sites |
| Tags and summary from email | A `Tags:`/`Summary:` block at the top of the body |
| Guided setup | `pnpm configure`, `pnpm configure:site <key>` |

Three sites configured, each with its own inbound address, sender allowlist and
API token. One GitHub token covers all three, scoped to the org.

## Things learned the hard way

Each of these cost a debugging round. They are here so they cost nothing next
time.

- **This repo is public.** Real inbound addresses and the Worker hostname
  reached `STATUS.md` and had to be scrubbed from git history. Use
  `example.com` placeholders in everything committed. `sites.jsonc` is
  gitignored; `pnpm check:secrets` blocks it from being staged, including via
  `git add -f`.
- **`pnpm deploy` silently does nothing** — pnpm reserves that name. Use
  `pnpm run deploy`.
- **A GitHub 404 means the token cannot see the repo**, not that the branch is
  missing. GitHub answers 404 rather than 403 so as not to confirm a private
  repo exists. Scope the PAT's resource owner to the **org**.
- **`wrangler tail` shows live traffic only.** Start the tail, *then* send the
  mail. Rejection reasons are logged; the sender only ever sees a generic
  `555 Message rejected`.
- **`draft: true` makes a post 404 on its own preview.** The Tailwind starter
  filters drafts out of `allBlogs` in production builds, and a Vercel preview
  is a production build. Posts are committed with `draft: false`; the PR is the
  gate.
- **The Workers runtime rejects a detached native `fetch`** with "Illegal
  invocation". `GitHubClient` binds it to `globalThis`; a test injecting a
  plain function will not catch a regression.
- **A hand-entered list needs both separators.** A space-separated allowlist
  stored as one string contains an `@`, passes a naive check, and then matches
  nothing — every message rejected, silently.
- **The PAT expires.** When posting starts failing with a 502, check that
  first.

## Confirmed by building it, not assumed

- **Frontmatter**: single-quoted YAML scalars, `tags` as an array.
- **`authors` is omitted** unless a real file in `data/authors` was resolved —
  an unknown author key breaks the site build.
- **SPF/DKIM verdicts do arrive.** This was expected to fail
  ([workerd#6740](https://github.com/cloudflare/workerd/issues/6740) reports
  Email Workers receiving `arc=none` with no verdicts); mail from a major
  provider carries passing verdicts, so the check works and
  `REQUIRE_AUTH_RESULTS` stays on.
- **MDX is not markdown.** `<https://example.com>` is valid markdown and a
  build error in MDX. Escaping was verified against `@mdx-js/mdx` v3 with the
  site's own remark plugins — a hand-rolled tag-balancing version failed on
  14% of fuzzed inputs where the blunt one fails on none.
- **Node 24**, not 20. Node 20 is EOL and outside Wrangler's supported range.

## Acceptance test

`examples/acceptance-test/` is the canonical check: **send that email, get a
draft PR that builds.** `pnpm test` diffs the pipeline against the recorded
`expected.mdx`, so most regressions are caught without sending anything;
`pnpm test:accept` regenerates it after a deliberate change.

Its README insists on looking at the *rendered* preview, not just a green
build. Mangled TeX compiles fine and renders as gibberish — which is the bug
writing that test uncovered.

## Known gaps

- **Raw HTML in a post body does not render** — a deliberate consequence of
  MDX escaping. Use `**bold**`. See the README.
- **An unbalanced backtick can still produce a body that fails to build.** The
  input markdown is already malformed in that case; CI is the backstop.
- **HTML-only email is rejected** with the same generic bounce as a security
  failure, so the reason is invisible to the sender. Most clients send a
  plaintext part alongside, so this is an edge case.
- **`POST_AS_DRAFT=true` makes the post 404 on the preview.** Left as an option
  because merging unpublished is a legitimate workflow.
- **Test PRs are open** on all three repos from verification runs.

## Next

**Shared CI across the site repos.** A reusable GitHub Actions workflow, since
all three sites share one stack and a post can reach a repo without passing
through post-inbox — the web editor, or a direct push. MDX compile check and
frontmatter validation as blocking checks; tag linting and spellcheck as
advisory. None of the three repos has any workflow or branch protection today.
See §11 of the design doc.

**GitHub App instead of the PAT.** Removes the expiry landmine, scopes per-repo
at the org level, and attributes commits to the app rather than to a person —
which matters once someone else's post is being committed.

**Rate limiting.** Cloudflare's native Worker-level limiting, per sender.

**Hash the per-site API tokens** rather than comparing them in plaintext.

## Backlog

- **Per-site GitHub and subject tokens.** Both are global today, so one GitHub
  credential writes to every repo. Deferred because the GitHub App supersedes
  the PAT and scopes properly, and three PATs to rotate is friction for a
  marginal gain. The tooling split already anticipates it.
- **Per-sender author mapping.** `authorsBySender` is in the site schema and
  `authorFileForSender` resolves it, so mapping a family member's address to
  their own author page is a config change rather than a schema change. No site
  populates it yet and it has not been exercised end to end.
- **Reply on success, with a link to the preview.** Confirming that a post
  landed, and where to look at it, closes the loop — right now success is
  silent and you go hunting for the PR.

  Two mechanisms, and **Resend is probably the right one** rather than merely a
  fallback:

  - **`message.reply()`**, the Email Workers primitive. No new dependency, but
    the constraints are severe: the incoming message must have a **valid DMARC
    result**, the reply may only go to the original sender, only one reply per
    message, and the sending domain must match the receiving domain. The DMARC
    rule is the blocker — Cloudflare's activity log shows `DMARC STATUS: none`
    on mail from the current sender, so this may be refused outright.
  - **Resend**, already in use for transactional mail elsewhere, so no new
    vendor. Sidesteps every constraint above: no DMARC requirement on the
    inbound message, any recipient, several messages per event, no
    domain-matching rule. Costs an API key and an outbound HTTP call rather
    than a platform primitive. §7 of the design doc rules out *replacing*
    Resend with Cloudflare's `send_email` binding, which is the same
    conclusion from the other direction.

  Either way the first reply cannot carry the Vercel preview URL: the PR is
  created before Vercel has built anything. Link the PR and let its checks
  carry the preview. Resend additionally allows a **second** message once the
  build finishes — "preview ready: <url>" — but something has to notice that,
  which means CI or a Vercel webhook rather than the Worker.

- **Reply-to-edit: revise a post by replying to the confirmation.** The most
  interesting of these and the least designed. Replying with corrections is a
  far better editing loop than opening a PR in a browser.

  What makes it tractable: an email reply carries `In-Reply-To` and
  `References` headers naming the `Message-ID` of the message being replied
  to. So the confirmation reply's own `Message-ID` is the tracking token — no
  need to put a sha or PR number in the body where a person might mangle it,
  though a visible `PR #12` is a useful human-readable fallback if the headers
  are lost.

  The unsolved parts, roughly in order of difficulty:
  - **Storing the mapping.** `Message-ID` → site + PR number + branch has to
    persist between two separate Worker invocations. Cloudflare KV is the
    natural fit; it is the first piece of state this system would own, which
    is a real change to its shape.
  - **What an edit means.** Replace the body wholesale, or apply the reply as
    a patch? Wholesale is predictable and easy to reason about; patching is
    what someone actually wants when they write "change the title to X".
  - **Quoted text.** A reply usually quotes the original, so the quoted block
    has to be stripped — the same class of problem as signature stripping, but
    with far less standardisation than `-- `.
  - **Commit onto the existing branch**, rather than opening a second PR.
    `createDraftPost` currently always cuts a new branch, so this needs a
    revise path alongside it.
  - **Authentication still applies.** A reply is a fresh inbound message and
    must pass the same allowlist and DKIM checks; knowing a `Message-ID` must
    not be sufficient to edit a post.

- **Make a failure bounce say why, when authentication succeeded.** A GitHub
  failure already rejects the message rather than dropping it, so a bounce
  arrives — but it says only `555 Message rejected`, the same as a security
  rejection. That is deliberate for auth failures, where naming the failed
  check tells an attacker something. Once a sender is authenticated, though,
  there is no reason to be coy: "could not write to the repository" is
  actionable where the generic message is not.

  Lower priority than it looks: a build failure surfaces via Vercel on the PR
  anyway. The gap is narrower — a failure that happens *before* a PR exists, so
  Vercel never runs and nothing else tells you.

- **HTML email → markdown**, via `turndown`. Currently rejected.
- **Attachments** — images and PDFs committed to the repo, MIME allowlist, size
  cap. HEIC conversion and resizing are a separate problem, likely a GitHub
  Action on the PR rather than in the Worker, since `sharp` needs native
  binaries a Worker cannot run.
- **The launch post**, written through the tool itself. See §9 of the design
  doc — this works now.
