# Status

**Working end to end on three real sites.** Email a site's address, get a pull
request with a building preview.

Last updated 2026-09-13. Worker version `77cd627b`, 180 tests passing.

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
| Author notification email | All three sites — Resend, via a shared reusable workflow, with a deep link to the pull request |
| MDX compile check | All three sites — blocking, verified red on invalid MDX and green once fixed |
| HEIC conversion | Cloudflare Images binding, verified end to end against a real iPhone HEIC |

Three sites configured, each with its own inbound address, sender allowlist and
API token. One GitHub token covers all three, scoped to the org.

## Author notifications

When a `post-inbox/*` branch gets a successful **preview** deployment, the post's
author is emailed a link straight to their post, plus a deep link to the pull
request. **Live on all three sites**, each calling one shared reusable workflow in
`TeamNickHart/.github`, pinned to the `v1` tag.

Sent by a GitHub Action in the blog repo rather than by the Worker, and the
reason is sequencing: post-inbox opens the pull request *before* Vercel has built
anything, so a notification sent at PR time could only link the pull request. The
Action runs on `deployment_status`, by which point the preview URL exists.

| Piece | Where |
|---|---|
| `.github/workflows/notify-author.yml` | blog repo — a thin caller of the shared workflow |
| the implementation | `TeamNickHart/.github`, `@v1` |
| `RESEND_API_KEY` | blog repo secret, on all three (one Resend key) |
| `AUTHOR_EMAIL_MAP` | blog repo secret, derived from `sites.jsonc` |
| `NOTIFY_FROM` | blog repo *variable*, `no-reply@<site domain>` |

**No address is ever committed or logged.** The post's frontmatter carries only
the author *name*; the address is looked up from the secret at send time and
masked in output, because an Actions log outlives the run and is readable by
anyone with repo access. This is also why the sender address was removed from the
pull request body.

A send failure never fails the build — the post is committed and the preview
built by the time it runs, so a missing notification is a courtesy not
delivered, not a reason to turn a check red.

**Resend and Cloudflare coexist, and neither replaces the other.** Cloudflare
Email Routing keeps inbound on the apex `MX`; Resend's three records all sit on
subdomains (`send` for `MX` and SPF, `resend._domainkey` for DKIM), so no apex
record is touched and the one-SPF-per-hostname rule never bites. Do **not** enable
Resend's Inbound feature — it would receive all mail for the domain and fight
Email Routing directly. Resend's free tier allows three domains; Pro at $20/mo
allows ten and removes the 100/day cap.

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
- **Vercel sets `deployment.ref` to a commit SHA, not a branch name.** A
  workflow filtering `startsWith(deployment.ref, 'post-inbox/')` skips on every
  event — silently, with nothing failing and the logs reading "skipped". Resolve
  the branch from `deployment.sha` with `git branch -r --contains`, which needs
  `fetch-depth: 0`. And exclude `environment == 'Production'`, or a merge sends a
  second email.
- **`pnpm configure:notify` writes to every site in `sites.jsonc`.** There is no
  `--site` flag yet, so setting up one site pushes the Resend key to all three.
  Delete the ones you do not want: `gh secret delete RESEND_API_KEY --repo ...`.

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

## Image resizing and format conversion: already handled

Worth writing down, because it was nearly built twice. The Tailwind starter
already pipes every markdown image through `next/image`: `remarkImgToJsx`
rewrites `![](...)` into the `Image` component, which wraps `NextImage`, and
`next.config.js` only disables optimization when `UNOPTIMIZED` is set. So on
Vercel, resizing and modern-format delivery happen for free, from whatever
source file the post points at.

That means **no conversion step, no originals directory, no manifest, no
gitignoring `public/`, and no CI image job.** An earlier plan had all of those,
plus a bot pushing converted files back to the pull request branch — which would
also have re-triggered the notification workflow and sent two emails per post.
All of it was solving a problem the template had already solved.

The only format it cannot handle is HEIC, which the Worker converts to JPEG at
upload instead — see below.

## Shared workflow: done, on all three sites

One reusable workflow in `TeamNickHart/.github` serves every site. Each blog repo
holds a thin caller pinned to `@v1`. Verified end to end on all three: a real
email per site with a working preview link and a deep link to the pull request.

| Site | Verified by |
|---|---|
| `weishart-site` | PR #9 |
| `nickhart-blog` | PR #16 |
| `jennyweis-blog` | PR #19 |

### Grant `pull-requests: read` on the calling job

This was the last bug, and it cost most of a day. **A top-level `permissions:`
block does not reach a `workflow_call` job.** The token then falls back to the
repo default — `Contents`, `Metadata`, `Packages`, no `PullRequests` — the pull
request lookup 403s, and the email links the pull request *list* instead of the
pull request.

The log says so plainly in its `GITHUB_TOKEN Permissions` group, which is the
first thing to read when a lookup 403s. `jennyweis`'s old per-repo copy is why
the asymmetry is easy to miss: it declares `permissions` top-level and works,
because a *self-contained* workflow has no called job to reach into.

Two dead ends recorded so they are not tried again:

| | |
|---|---|
| Passing `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` down as a secret | Cannot work — same token, same grant. Worse, GitHub rejects `secrets.GITHUB_TOKEN` passed by name into a reusable workflow, which is what made one run end `failure` instead of skipping. |
| Declaring `permissions` in the caller *and* on the called job | The called workflow can only reduce the grant, never elevate it. |

### What the bisection established

Both earlier startup failures were the same lesson — a called workflow inherits
far less than it looks like it should:

| | |
|---|---|
| `vars.NOTIFY_FROM` | A called workflow cannot read the caller's variables. The caller reads it and passes `mail-from` as an input. |
| `path: ${{ runner.temp }}` | The `runner` context does not exist at parse time, so it cannot appear in a `with:` block. `path` is repo-relative anyway. |

Ruled out, so nobody re-checks them: `actions/checkout@v5`, malformed YAML, the
job-level `if:`, and every individual step.

### Pinning, and the gap that made it decorative

All three callers use `@v1` rather than `@main`, so an upstream change reaches no
site until the tag moves. `v1` is a *mutable* annotated tag: it is a release
boundary, not an immutability guarantee. Swap it for a commit SHA per site if that
ever matters more than picking up fixes by moving one tag.

The pin was initially decorative, because the workflow fetched its own script
with a hardcoded `ref: main` — the workflow was frozen and the code it executed
was not. It now checks out at `github.job_workflow_sha`, the commit the workflow
file itself was resolved from. Not `github.workflow_sha`, which is the *caller's*
commit and does not exist in `.github`.

**That one line is not yet proven.** Whether `job_workflow_sha` is populated
inside a called workflow is a reading of the contexts reference, not an observed
fact, so the send step echoes the SHA and fails loudly if the checkout produced
no script. The next post's log settles it — look for `Shared script pinned to:`
naming a real SHA.

### Two traps that cost cycles, both about *what gets tested*

- **A `deployment_status` run loads the workflow from the branch that deployed**,
  not from the default branch. A fix on `main` does nothing for a run triggered
  by a preview on an older branch. The `Uses: owner/repo/....yml@ref (sha)` line
  in the log is the only reliable evidence of which version ran — read it before
  believing a green run.
- **An empty commit produces no Vercel build**, so it cannot trigger a preview at
  all: no file diff, no deployment, no event. Touch a non-content file instead.
  And never append an HTML comment to a committed `.mdx` — `<!--` is invalid MDX
  and breaks the build, which then looks like a product bug.

## MDX compile check: blocking on all three sites

Every pull request compiles every post before it can merge. One reusable
workflow in `TeamNickHart/.github@v1`; each site holds a thin caller. The
required-check context is `mdx / mdx`, required on all three rulesets.

It runs the site's **own** `contentlayer2 build` rather than a plugin list kept
in the shared repo. The sites carry a substantial remark/rehype stack (gfm,
math, katex, citation, prism, pliny's imgToJsx, github-blockquote-alert,
preset-minify), and a copy of that list would drift — a check that disagrees
with the real build is worse than no check, in both directions. Not `next
build`, which also wants env vars and Vercel config and would fail for reasons
unrelated to the post.

Verified in both directions rather than assumed: on a post containing
`<https://example.com>` it exits 1 and names the file, position and character;
with the post removed, the same branch goes green. Vercel failed and passed on
the same two commits, about 100 seconds later each time.

### A required check must not have a `paths:` filter

The check first shipped with `paths:` limiting it to `data/**` and the build
files. That interacts badly with making it *required*: a pull request touching
no matching path never runs the check, the required context never reports, and
the pull request is **unmergeable with nothing to click**.

Proved with a README-only pull request: `mergeable=MERGEABLE`,
`state=BLOCKED`, Vercel and notify both green, and no `mdx / mdx` row at all. A
required check that does not run is invisible rather than red, which is what
makes it confusing to hit cold.

So the filter is gone and the check runs on every pull request. About 100
seconds, which is a good trade. The same filter had already hidden a subtler
problem: the pull request that first *added* the check matched none of its own
paths, so the check shipped to three repos without once being seen to run.

## HEIC conversion: in the Worker, via Cloudflare Images

An iPhone shoots HEIC by default and iOS Gmail attaches it as HEIC, so this was
the one format that reached a post as a refusal rather than an image. The Worker
now converts it to JPEG before anything else looks at it.

**The refusal it replaces was worse than it appeared.** Its message told the
sender to change a camera setting, but a rejected attachment is surfaced in the
*pull request body*, not a bounce — only whole-message rejections bounce. So the
sender got a notification saying the post was ready, with the photo silently
missing unless they opened the PR. The advice never reached anyone.

### Why not a GitHub Action, which was the recorded plan

`sharp` needs native binaries a Worker cannot run — that part was right. But
**prebuilt `sharp` cannot decode HEIC anywhere.** Tested against a real iPhone
HEIC: it reads the container (4284x5712, EXIF present) and then fails
`bad seek` on pixel decode, because HEVC is patent-encumbered and excluded from
the prebuilt binaries ([sharp#3680](https://github.com/lovell/sharp/issues/3680)).
So the Action route needed a hand-built libheif, plus `contents: write`, plus
`ref: github.head_ref`, plus a second metadata-stripping pass — and
`heif-convert` copies EXIF including GPS straight into the JPEG.

Worse, a commit made with `GITHUB_TOKEN` does not re-trigger workflows, so the
required `mdx / mdx` check would not re-run and the pull request would sit on a
stale status.

A Vercel route was a dead end for a different reason: `remarkImgToJsx` reads
image files off disk at *build* time, so a runtime endpoint cannot get the JPEG
into the repo at all.

### What the binding does, all of it measured

| | Observed |
|---|---|
| HEIC decode | `info()` reports `image/heic`; output is a valid JPEG at source dimensions |
| EXIF | **Stripped entirely.** 2,934 bytes in, only `APP0/JFIF` out — no APP1, no GPS |
| Rotation | **Baked into pixels.** 400x200 tagged `Orientation = 6` came back 200x400, untagged |
| Colour | Channel means within ~1.6/255 of a libheif reference decode, despite ICC being dropped |
| Non-image | Clean throw, code `9412` — also catches video, so a misdeclared `.mov` fails safely |
| Bad HEIC | Clean throw, code `9516`, usefully distinct from 9412 |

The binding exposes **no `metadata` option** — that exists on the URL-based
transform API but not in `ImageTransform` — so stripping is not configured, it is
simply what the re-encode does. `stripImageMetadata` still runs afterwards as
defence in depth and finds nothing left, which is why a converted attachment
reports `strippedMetadata: []` while a directly-attached JPEG still reports
`GPS`, `device`, `timestamp`, `XMP`, `APP13`.

### Shape of it

Conversion is a pre-pass, so `planAttachments` stays synchronous and pure:
`convertAttachments` (`src/core/imageConversion.ts`) runs first, and
`emailToPost` became `async` to await it. Detection is by content —
`looksLikeHeic` reads the ISO-BMFF `ftyp` brand — because the declared type is
the sender's client's opinion and Gmail sends `application/octet-stream`. The
brand list is an allowlist, since `ftyp` fronts MP4 and QuickTime too.

The only Cloudflare-aware file is `src/adapters/cloudflare/imageConverter.ts`.
`ImageConverter.toJpeg` returns `null` rather than throwing, because declining is
the expected path — and every decline lands on the pre-existing refusal, so the
post still gets created. A failed conversion sets `refusalOverride`, so the
message does not blame a camera setting that was not the problem.

A JPEG never reaches the converter: no transformation is billed, and its ICC
profile survives. Free tier is 5,000 unique transformations a month and each
conversion is logged, so usage is visible before it is a surprise.

### Verification

`.heic-e2e/` (gitignored) is a throwaway harness that drives the *shipped*
converter and pipeline against the live binding:

```
npx wrangler dev --remote --config .heic-e2e/wrangler.jsonc --port 8798
curl -s -X POST --data-binary @photo.heic -H 'x-mime: image/heic' localhost:8798/
```

`wrangler dev` without `--remote` uses a low-fidelity local Images
implementation supporting only width/height/rotate/format, so HEIC will not
decode there. One caveat: a 3.4MB body failed through miniflare's remote-preview
*proxy* (`RangeError` inside ProxyWorker) while a small HEIC through the same
path succeeded — real inbound email does not touch that proxy, but full-size
verification needs a deployed Worker.

### Verified in production, on a real iPhone HEIC

Emailed from iOS Gmail with the photo attached **from the Files app**, through
the deployed Worker:

| | Result |
|---|---|
| Conversion ran | `Converted IMG_6899.heic from image/heic`, and the pull request said `(1 converted from image/heic)` |
| Committed as | `.jpg`, named from the slug |
| Dimensions | **4284x5712 portrait** — the full 24 megapixels, not a thumbnail |
| Orientation | **Upright, with no orientation tag** — rotation baked into pixels, confirmed by looking at the rendered image rather than inferring it from dimensions |
| EXIF | **None at all.** No GPS, no device, no timestamps |
| Colour | Natural, despite the ICC profile being dropped |

That closes the risk flagged as most likely to sink this feature: a portrait
photo rendering sideways. It was proven here on a real camera file, where the
earlier local check used a synthetic `Orientation = 6` fixture.

### Which iOS paths actually deliver a HEIC

Mapped by sending the same photo three ways, and the answer matters because two
of the three never exercise conversion at all:

| How it was sent | What arrived |
|---|---|
| Photos share sheet → Gmail extension | **Rejected** — HTML-only, no plaintext body |
| Gmail, attach from Photos | Gmail re-encoded it to JPEG itself |
| **Gmail, attach from Files** | A real `.heic` — converted ✅ |

So HEIC reaches the Worker less often than expected: iOS Gmail converts on send
whenever it handles the photo itself, and only an opaque Files attachment
survives. The feature still earns its place for macOS Mail, Files-attached mail,
and forwarded iPhone photos — but the common case was already working.

### The directly-attached JPEG path, also verified

Incidentally proven by the same round of tests, on a real 24 megapixel camera
file — which `stripImageMetadata` had never been checked against:

- EXIF reduced to **32 bytes**: one IFD entry, the orientation, and nothing else
- **GPS, device and timestamps removed**
- ICC profile **kept**
- 4284x5712 portrait, upright

So `rebuildExif` does work on real camera output, not only on the synthetic EXIF
in its unit tests.

## Known gaps

- **Raw HTML in a post body does not render** — a deliberate consequence of
  MDX escaping. Use `**bold**`. See the README.
- **An unbalanced backtick can still produce a body that fails to build.** The
  input markdown is already malformed in that case, and the MDX check now blocks
  it at the pull request rather than letting Vercel find it.
- **`POST_AS_DRAFT=true` makes the post 404 on the preview.** Left as an option
  because merging unpublished is a legitimate workflow.

## Next

**Shared CI: the blocking half is done, the advisory half is not.** All three
repos now protect `main` (pull request required, `mdx / mdx` required) and
compile every post on every pull request. What §11 of the design doc still
wants:

- **`cspell` and `markdownlint`, advisory.** Write to `$GITHUB_STEP_SUMMARY`
  rather than a pull request comment — the summary needs no permissions at all,
  where commenting needs `pull-requests: write`, a real escalation on a token
  that could then modify pull requests.
- **Tag linting**, last: normalize existing tags and flag a near-match
  (`next-js` against `nextjs`), scanning posts' frontmatter rather than a
  maintained list. Most likely of the four to annoy.
- **Frontmatter validation** — but in *post-inbox*, at parse time, not as a
  pull request check. The Worker generates that frontmatter, so an invalid date
  is a bug to fix where it is introduced, and the email path can bounce with the
  reason before a branch exists. A CI version is worth keeping only as a backstop
  for web-editor and direct-push edits.

**Notification email linking the check results.** The natural follow-on: the
email says "checks are running, see them here" and points at the pull request's
Checks tab. Deliberately a *link* rather than inline counts — the notification
fires on `deployment_status` and the checks on `pull_request`, which are
independent races, so reporting results inline would intermittently claim "no
issues" while the checks were still running.

**GitHub App instead of the PAT.** Removes the expiry landmine, scopes per-repo
at the org level, and attributes commits to the app rather than to a person —
which matters once someone else's post is being committed.

**Rate limiting.** Cloudflare's native Worker-level limiting, per sender.

**Hash the per-site API tokens** rather than comparing them in plaintext.

**Per-sender author mapping: notifications done, inbound routing not.** Two
different maps, easy to conflate. `weishart-site`'s `AUTHOR_EMAIL_MAP` now holds
all four authors with their real addresses, so a post by any of them notifies the
right person. What remains is the *inbound* direction — an `authorsBySender` map
in `sites.jsonc`, so mail from each family member's address is attributed to
their author rather than the site default — then `pnpm check:authors` and a test
email from each address.

**Per-site GitHub tokens are supported but not in use.** All three sites still
fall back to the one org-scoped `GITHUB_TOKEN`. Setting
`<SITE>_GITHUB_TOKEN` per site would contain a leak to one repo; worth doing
when the GitHub App lands, since App installation tokens are naturally
per-installation.

## Backlog

- **Signatures without the `-- ` delimiter are not stripped, and leak the
  sender's address into a public repo.** iOS Gmail writes a signature as bare
  trailing lines — name, email address, URL — with no RFC 3676 delimiter, so
  `stripSignature` correctly finds nothing and the block lands in the post body.
  Observed on three real test posts, each of which put a real email address on a
  branch of a public repository.

  A heuristic fallback is the fix, and it needs care: a trailing block of short
  lines containing an address or a bare URL, only at the very end of the body,
  and only when it is short. Eating real content would be worse than leaking a
  signature, so this should err towards leaving text alone and be covered by
  tests built from real messages. Until then, a sender's signature reaches the
  repo whenever their client omits the delimiter.

- **HTML-only mail is rejected, which breaks the most natural way to post a
  photo from a phone.** The iOS Photos share sheet composes HTML with no
  plaintext part, so `emailToPost` rejects it with "no plaintext body" — the
  path a person would reach for first.

  Smaller than it sounds: `postal-mime` already parses `email.html` and the
  adapter simply discards it (`src/adapters/cloudflare/index.ts` passes only
  `email.text`). So this is converting HTML to markdown for a known, narrow set
  of clients rather than building a general converter — headings, bold, italic,
  links, lists, and `<img>` tags mapped back to the attachment they reference.

- **Two posts render with two H1s.** `MD025` is the one markdown rule left
  enabled, and it finds real problems in `nickhart-blog`:
  `5-ways-ai-helped-me-handle-my-mothers-passing.mdx:10` and
  `markdown-writing-workflow.mdx:10`. Each opens with a body `# Heading` while
  the layout already renders the frontmatter title as the page's H1, so the page
  ships two — which hurts screen readers and SEO. The fix is demoting each to
  `##`. Left for the author rather than done automatically, since it edits
  published prose. The advisory prose check will keep reporting them until then.

- **Polish the initial setup: `pnpm setup` and `pnpm doctor`.** Setup has grown
  by accretion and now spans two secret stores with two different tools, which
  is obvious while building it and baffling six months later:

  | Secret | Store | Tool | Set by |
  |---|---|---|---|
  | `GITHUB_TOKEN`, `EMAIL_SUBJECT_TOKEN` | Cloudflare | `wrangler secret put` | `pnpm configure` |
  | `<SITE>_API_TOKEN`, per-site overrides | Cloudflare | `wrangler secret put` | `pnpm configure:site` |
  | `RESEND_API_KEY`, `AUTHOR_EMAIL_MAP` | GitHub repo | `gh secret set` | `pnpm configure:notify` |

  **Name by intent, not by destination.** `config:github` / `config:cloudflare`
  was considered and rejected: it makes the store obvious, but scatters one
  logical task across two commands — adding a site would mean running both and
  remembering which secrets live where, which is knowledge the tool should hold.
  It also bakes in a destination that is likely to move: if `RESEND_API_KEY`
  goes org-level, or the notification moves back into the Worker,
  `config:github` becomes a lie. Each command should instead *say* which store
  it is writing to as it runs.

  ```
  pnpm setup              # the front door: walks everything, in order
  pnpm setup:site <key>   # one site, whichever stores it needs
  pnpm setup:notify       # notifications
  pnpm doctor             # what is set, missing, or drifted
  ```

  `pnpm setup` matters most: there is no single entry point today, so a fork has
  to read the README to discover three commands and the order to run them in.

  **`pnpm doctor` is the piece most worth building.** Secrets cannot be read
  back, so today the only way to find a gap is to send mail and watch it fail —
  which is exactly how two real problems were found the slow way: an
  `API_TOKEN` mismatch that produced a bare 401, and a `WEISHART_ALLOWED_SENDERS`
  value that was one malformed string matching no sender at all. Doctor should
  report, per site, which Cloudflare secrets exist, which GitHub secrets exist,
  what `sites.jsonc` expects, and where those disagree — without printing a
  single secret value.

  Also: `<SITE>_ALLOWED_SENDERS` secrets are now unused, since the allowlist is
  derived from `authorsBySender`. They are still set on the Worker and should be
  deleted — `pnpm doctor` would flag exactly this.

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

- **Encode the site in the notification sender address.** A prerequisite for
  reply-to-append once one sending domain is shared across sites.

  Resend's free tier allows three verified domains, which happens to match the
  three blogs — but other projects want domains too, and Pro is $20/mo for ten.
  So the intent is one shared sending domain once the workflow is solid, running
  on two while it is built.

  Sharing a sender breaks reply routing: a reply to a `jennyweis` post sent from
  `no-reply@weishart.com` arrives at `weishart`'s inbound address and would
  append to the wrong repository. Subaddressing fixes it —
  `no-reply+jennyweis@weishart.com` — since the `+tag` survives a reply in most
  clients and Cloudflare Email Routing can match on it. The append handler reads
  the tag to pick the site rather than trusting the destination address.

  Worth settling at the same time: whether the tag is the site key, which is
  guessable, or an opaque per-site token. Guessable is probably fine, since an
  append must still pass the sender allowlist and DKIM — but it deserves a
  decision rather than a default.

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
  - **HEIC/HEIF are converted to JPEG** by the Cloudflare Images binding before
    anything else looks at them, so the sanitiser sees a JPEG it understands
    rather than an ISO base media container it does not. A site without the
    binding, or one setting `assets.convertImages: false`, still refuses them
    with the iPhone-setting advice.

  For the **JPEG** path, `rebuildExif` is now verified against a real 24
  megapixel camera file: EXIF came out as 32 bytes — one entry, the orientation
  — with GPS, device and timestamps gone and the ICC profile kept. What remains
  untested is specifically a JPEG whose orientation is `6` or `8` rather than
  `1`; modern iPhones write true portrait dimensions instead of tagging a
  rotated landscape frame, so such a file is harder to come by than expected.

  For the **converted** path this is now settled, and favourably: the Images
  binding bakes rotation into the pixels. A 400x200 JPEG tagged
  `Orientation = 6` came back 200x400 with no orientation tag at all, so a
  converted portrait photo is upright without depending on a tag surviving
  anything.

- **Place images by MIME part order, for clients that write no placeholder.**
  macOS Mail composes `multipart/mixed` with images interleaved between text
  parts — "HEIC image:", image, "JPG image:", image — and writes no
  `[image: ...]` marker anywhere. `postal-mime` flattens that to a single text
  blob, so the interleaving is lost and every image is appended at the bottom
  under one heading, away from the label it belonged to.

  Recovering it means walking the MIME tree in order rather than reading
  `email.text`, which `postal-mime`'s top-level API does not expose. A real
  feature, not a patch.

  Worth recording what the two real clients actually send, because no single
  field identifies an embedded image:

  | | Gmail web | macOS Mail |
  |---|---|---|
  | container | `multipart/related` | `multipart/mixed` |
  | `disposition` | `attachment` | `inline` |
  | `related` | `true` | absent |
  | `contentId` | present | absent |
  | placeholder in text | `[image: name]` | none |

  So `disposition` alone would miss Gmail, and `related` alone would miss
  macOS Mail. The filename-mention and append fallbacks are what carry both.

- **HTML email → markdown**, via `turndown`. Currently rejected. The real
  message carries an HTML part alongside the plaintext one, so the input is
  already there — it is only ignored.

- **Email bare media into the asset library.** Needs discussion before
  building; the easy path is small and the interesting parts are not.

  The shape: an email carrying attachments and no real body becomes a commit
  that adds files to the site's assets directory, with no post. Most of the
  machinery exists — the MIME allowlist, size caps, slug-based naming, metadata
  stripping and binary commits are all already there.

  What has to be settled first:

  - **What counts as "no body"?** A signature-only message and a subject with no
    body are both *already* rejections with their own bounce text, so the trigger
    has to be unambiguous or it collides with them. An explicit `Assets:` header
    or a reserved subject prefix is safer than inferring from an empty body.
  - **Where do the files go, and under what names?** Post attachments are named
    from the post slug, which does not exist here. Sender-supplied names are
    attacker-controlled and collide in a flat directory — the reason slug-based
    naming exists at all.
  - **Auto-rebasing open PRs is the genuinely complex part.** If assets land on
    the main branch while several post PRs are open, those PRs are behind.
    Rebasing means force-pushing branches that may be under review, and each
    rebase triggers a fresh preview build — so one asset email could kick off
    several deploys at once. A post that references an image added afterwards
    still will not see it until merged, so the rebase does not even buy what it
    looks like it buys.
  - **It overlaps with reply-to-append**, which solves "add media to a post" more
    precisely: a reply targets one pull request instead of mutating every open
    one. If reply-to-append lands first, the remaining use for this is seeding
    the asset library independently of any post — worth having, but a smaller
    feature than it first appears.

- **The launch post**, written through the tool itself. See §9 of the design
  doc — this works now.
