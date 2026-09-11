# Status

**Working end to end on three real sites.** Email a site's address, get a pull
request with a building preview.

Last updated 2026-09-10. Worker version `77cd627b`, 180 tests passing.

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
| Per-site GitHub and subject tokens | Resolved per site, falling back to the global value |
| Bounce messages | Generic for auth failures, specific once the sender is authenticated |
| Per-sender author mapping | Resolved on both paths, validated, `pnpm check:authors` |

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

`examples/acceptance-test/rejections/` covers the other half: how a message is
turned away, and what the sender should see. The exact sender-facing text is
asserted against what those docs promise, so a message cannot be reworded
without the documentation failing the build.

## Known gaps

- **Raw HTML in a post body does not render** — a deliberate consequence of
  MDX escaping. Use `**bold**`. See the README.
- **An unbalanced backtick can still produce a body that fails to build.** The
  input markdown is already malformed in that case; CI is the backstop.
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

**Per-sender author mapping is supported but not configured.** `weishart-site`
already has `dominic.mdx`, `jenny.mdx`, `luca.mdx` and `nick.mdx` in
`data/authors`, so adding an `authorsBySender` map to that site in `sites.jsonc`
is all that remains — then `pnpm check:authors` and a test email from each
address.

**Per-site GitHub tokens are supported but not in use.** All three sites still
fall back to the one org-scoped `GITHUB_TOKEN`. Setting
`<SITE>_GITHUB_TOKEN` per site would contain a leak to one repo; worth doing
when the GitHub App lands, since App installation tokens are naturally
per-installation.

## Backlog

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

- **Reply to append: add to a post by replying to the confirmation.**
  Replying with the images or tags you forgot is a far better loop than opening
  a PR in a browser.

  **Scope: additive only.** A reply appends body text, adds tags, or adds
  attachments. It never rewrites or deletes anything. A destructive syntax could
  come later, but deliberately not first — and narrowing to append removes the
  hardest problem rather than working around it:

  - *No intent parsing.* "Change the title to X" needs interpretation and can
    go wrong destructively. "Here are the images I forgot" has one meaning.
  - *Quoted text stops being dangerous.* With wholesale replacement, failing to
    strip a quoted block corrupts the post. With append, a stray quote is
    visible noise at the bottom of a diff you are already reviewing.
  - *A duplicate reply is visible, not silent.* It adds a duplicate section you
    can see and delete, rather than overwriting something.

  What makes the plumbing tractable: an email reply already carries
  `In-Reply-To` and `References` naming the `Message-ID` it replies to. So the
  confirmation's own `Message-ID` is the tracking token — nothing needs to
  survive in the body where a mail client might mangle it, though a visible
  `PR #12` is a useful human-readable fallback.

  Still to decide when building it:
  - **Storing the mapping.** `Message-ID` → site + PR number + branch has to
    persist across two Worker invocations. Cloudflare KV is the natural fit, and
    it would be the first state this system owns — a real change to its shape.
  - **Where appended content lands.** If the post already ends with an "Images"
    section, does a second batch join it or start a new one? Joining is tidier;
    starting fresh is more predictable and simpler. Predictable probably wins.
  - **Tags are a merge, not an append.** A `Tags:` line in a reply means "add
    these to the existing list", which edits frontmatter rather than appending
    to the body — a different code path, reusing the case-insensitive
    de-duplication already in `parseHeaders`.
  - **Commit onto the existing branch**, rather than opening a second PR.
    `createDraftPost` always cuts a new branch, so this needs a revise path
    alongside it.
  - **Authentication still applies in full.** A reply is a fresh inbound
    message and must pass the same allowlist and DKIM checks. Knowing a
    `Message-ID` must never be sufficient to change a post.
  - **Attachments are a prerequisite** for the case that motivates this most —
    forgotten images. See the attachments item below.

- **Further image metadata sanitation at upload.** GPS, device model,
  timestamps, maker notes, XMP and the embedded thumbnail are stripped from
  JPEG today, with orientation deliberately preserved and the ICC profile kept
  for colour fidelity. What survives on a real iPhone photo, checked segment by
  segment:

  - **MPF (Multi-Picture Format), 88 bytes.** An Apple multi-image index, and it
    survives *by accident*: the strip rule covers `APP3..APP15`, and MPF sits in
    APP2 alongside ICC. It can carry offsets to a second embedded image. Should
    be dropped — distinguish it from ICC by the segment's identifier string
    rather than by marker number.
  - **ICC colour profile, 552 bytes.** `Display P3`, which names a device class
    rather than a device. Worth keeping: dropping it visibly shifts the colour
    of a wide-gamut photo. A build step that converts to sRGB could then drop
    it safely.
  - **PNG and WebP** have only their known metadata chunks removed. Neither has
    been checked against a real camera file the way JPEG has.
  - **HEIC/HEIF are not sanitised at all** — an ISO base media container where
    metadata is structural rather than a removable segment, so `stripsCleanly`
    reports false and the bytes pass through untouched, GPS included. This is
    the real hole: an unconverted iPhone photo keeps its coordinates. Closing it
    means either a real container parser or refusing HEIC until the build step
    converts it.

  Also unverified: that a **portrait** photo's `Orientation = 6` or `8` survives.
  The only real camera file tested was upright, and the orientation tests use
  synthetic EXIF. If it does not survive, portrait photos render sideways.

- **HTML email → markdown**, via `turndown`. Currently rejected. The real
  message carries an HTML part alongside the plaintext one, so the input is
  already there — it is only ignored.
- **Attachments** — images and PDFs committed to the repo, MIME allowlist, size
  cap. HEIC conversion and resizing are a separate problem, likely a GitHub
  Action on the PR rather than in the Worker, since `sharp` needs native
  binaries a Worker cannot run.
- **The launch post**, written through the tool itself. See §9 of the design
  doc — this works now.
