# Post Inbox — Design Plan

A system to create draft blog posts — as a branch + PR with a live Vercel
preview, never published directly — triggered either by sending an email
or by a direct HTTPS POST (e.g. from an iOS/macOS Shortcut). Supports
multiple sites and multiple users per site.

Status: **planning complete, not yet built.**

---

## 1. Sites

| Site | Stack | Users | Notes |
|---|---|---|---|
| nickhart.com | Tailwind Nextjs Starter Blog | Nick | Currently under Nick's personal GitHub account |
| jennyweis.com | Static bio page (not yet a blog) | Jenny | Feature applies once/if this becomes a real blog |
| weishart.com | Tailwind Nextjs Starter Blog | Nick + Jenny | Family blog, same stack as nickhart.com |

All three repos should live under the **TeamNickHart** GitHub org.
nickhart.com needs to be transferred there from Nick's personal account
first — this isn't optional plumbing, it's what lets one GitHub App
installation cleanly cover all three repos instead of juggling
personal-account + org access.

---

## 2. Architecture

```
Email → Cloudflare Email Routing → Worker (email handler)  ─┐
                                                               ├─→ createDraftPost()  →  GitHub API  →  branch + commit + PR
Shortcuts / other → HTTPS POST → Worker (fetch handler)    ─┘
```

One Cloudflare Worker, two entry points, one shared core function. The
email handler parses the raw message and reshapes it into the same
payload the HTTPS endpoint expects, then both call the identical
`createDraftPost()` function. That function is the only thing that ever
talks to GitHub.

**Repo:** lives in its own new repo (e.g. `post-inbox`), separate from
all three site repos — it's infrastructure that writes *to* multiple
repos, so it doesn't belong inside any one of them.

**GitHub access:** a GitHub App installed on the TeamNickHart org
(preferred over a personal-access-token now that all repos share one
owner) — narrowly scoped permissions (Contents: read/write, Pull
requests: read/write), easy to audit and revoke.

---

## 3. Security

This is the part that actually matters most, and splits into two
different trust problems:

**HTTPS path:** require a bearer token per user. Reject anything without
a valid one. Straightforward.

**Email path (the real risk):** a "From:" header is trivially fakeable.
The fix is *not* a hard-to-guess address (bots harvest addresses
regardless) — it's checking the email's actual SPF/DKIM authentication
results and only accepting mail that passed authentication from an
explicitly allowlisted sending address per user. Reject everything else
before it ever reaches post-creation logic. This is the single most
important security decision in the system.

**Other layers:**
- MIME-type allowlist on attachments — images and PDF only, reject
  everything else even from an authenticated sender
- Attachment size cap: ~10–15MB (matches where GitHub's Contents API
  stays reliable, and doubles as abuse prevention)
- Cloudflare's native Worker-level rate limiting, per sender/token

---

## 4. Attachments

**Decision: committed directly into the git repo**, not Cloudflare R2.
Simpler, self-contained, and typical blog-image/PDF sizes sit
comfortably within GitHub's Contents API limits given the size cap
above. R2 was considered and explicitly rejected for now as unnecessary
complexity — could revisit if attachment volume/size ever becomes a
real problem.

---

## 5. Email → Markdown transformation

Assumption: **plaintext email body.** No HTML-to-markdown conversion
needed.

1. Generate frontmatter from what's available: title from subject, date
   from the email timestamp, author from the mapped user. Confirmed
   schema, pulled directly from the template's own docs and example
   posts — title and date required; tags, lastmod, draft, summary,
   images (array), authors (array of filenames in `data/authors`,
   defaults to `default`), layout, and canonicalUrl all optional.
2. Body text passes through as-is — markdown the user typed in the email
   is preserved untouched.
3. Bare URLs (not already inside `[text](url)` or `<url>`) get
   auto-wrapped into proper markdown links.
4. Images: check whether the attachment's filename appears anywhere in
   the body text. A match → replace that mention with a markdown image
   tag at that position. No match → append to a trailing "Images"
   section. (This filename-mention check is the only reliable signal
   available for placement in a plaintext email — there's no true
   inline/CID embedding the way HTML email has.)
5. Non-image attachments (PDFs): always appended as a link in a trailing
   section, regardless of whether mentioned in the body.

**Still to confirm when building:** the exact asset path convention the
Tailwind starter expects for post images (needs checking against the
actual repo structure).

---

## 6. Image processing (HEIC conversion, resizing) — DEFERRED

Explicitly **not designed in detail yet** — this is its own concern,
decoupled from core post creation, to be explored when we're ready to
build it rather than speculated on now.

What's already known, to save re-deriving it later:
- `sharp` (the usual Node tool for this) won't run in a Cloudflare
  Worker — it needs native binaries, Workers can't execute those.
- WASM-based HEIC decoders are real and actively maintained (e.g.
  `heic-to`, tracking current libheif releases), and Workers do support
  running WASM — so in-Worker conversion is *plausible*, not ruled out.
- Open question to settle by actually testing, not assuming: whether a
  WASM HEIC decoder fits comfortably within Worker bundle size limits.
- **Fallback if the in-Worker approach proves awkward:** do the
  conversion as a GitHub Action step that runs on the PR instead — full
  Linux runner, real native tools available, no Workers constraints.
  This is now considered a legitimate primary option, not just a
  fallback, worth evaluating on equal footing with in-Worker WASM when
  we get here.
- Proposed configurable defaults (not final): target format `webp`, max
  dimension `2000px` (longest edge), quality `80`. Goal is a reasonable
  default, not a perfect pipeline.

---

## 7. Prior art (researched, not adopted wholesale)

No turnkey tool matches this exactly. Closest reference: **"Mail to
Blog"** (Arpit Gupta, built for a Postmark hackathon) — same general
shape (email → Cloudflare Worker → parsed → committed to GitHub) for a
Hugo site. Differs in two real ways: uses Postmark for inbound parsing
instead of native Cloudflare Email Routing, and publishes directly
rather than opening a draft PR — no safety net. Worth a look for
implementation ideas, not a fit to copy directly.

Cloudflare's own Email Workers documentation independently confirms the
core building blocks (`postal-mime` for parsing, the `email` handler,
committing from a Worker via the GitHub API) — validates the approach
without providing a packaged product.

**Explicitly ruled out:** replacing Resend (outbound transactional
email) with a self-hosted or Cloudflare-native alternative. Cloudflare's
`send_email` binding can't reach arbitrary recipients without the
Workers Paid plan, is still in beta, and has weaker deliverability
tooling than a dedicated provider — would be a downgrade for actual
transactional use (magic links, notifications), not an improvement. Not
solving a problem that currently exists.

---

## 8. Open items before/while building

- [ ] Move nickhart.com's repo into the TeamNickHart org
- [ ] Confirm exact frontmatter schema against real post files
- [ ] Confirm image asset path convention in the Next.js template
- [ ] Decide GitHub App scopes precisely and install on the org
- [ ] Design the site/user config format (likely a static config file
      to start — repo, branch, content path, allowed users + tokens/
      allowlisted senders per site)
- [ ] Image processing: evaluate in-Worker WASM vs. GitHub Action once
      ready to build this piece specifically
- [ ] Choose license (MIT) and add a LICENSE file
- [ ] Write a README
- [ ] Confirm no personal config or secrets ever land in git history
- [ ] Draft the announcement post — ideally composed *through* the tool
      itself (see Section 9)

---

## 9. Open source & the launch post

**License:** MIT — standard, simplest choice for a tool like this, no
reason to overthink it.

**What "open source" actually changes in the design:** the config/
secrets separation already flagged above stops being a nice-to-have
once the repo is public and becomes a real requirement. Site configs
(repo mappings, user lists) and all credentials (GitHub App keys,
bearer tokens, allowlisted sender addresses) must live outside the
committed code entirely — environment variables / Wrangler secrets,
with a `config.example.json` (or similar) checked in as a template for
anyone who forks it. Nothing personal or sensitive should ever touch
git history.

**Scope decision:** build this for the three sites it's actually meant
for, not as a generalized multi-tenant product for strangers to onboard
into. Keeping the config/secrets boundary clean already makes it
forkable by anyone who wants to adapt it — that's a reasonable bar,
distinct from building polished onboarding for external users, which
is a bigger scope nobody's asked for.

**The launch post:** there's a genuinely good hook sitting right here —
the first real post on the rebuilt nickhart.com could be written
*using the tool itself*. Draft it by sending an email and letting the
system turn it into the post, so the post becomes its own
demonstration. "I built a system that turns an email into a blog post;
you're reading the proof" is a considerably stronger opener than
describing the tool after the fact.

---

## 10. Community check & portability

**Prior art check (searched the template's own issues, discussions, and
README):** nothing matching this exists for the Tailwind Nextjs Starter
Blog specifically. The template's "Newsletter API" support is the
opposite direction — emailing subscribers when a post publishes, not
creating a post from an email. One adjacent, non-competing data point:
a fork of this template family ("BloginHub") uses GitHub Issues as a
CMS trigger for posts — different mechanism, no draft/preview safety
net, but shows "external trigger auto-creates a post" isn't a foreign
concept in this ecosystem. Can't rule out something existing entirely
outside searchable space, but nothing found in the community's own
venues.

**Scope commitment, given nothing to bump up against:** the "nearly
turnkey for others" bar is the real standard to hold here, not a hedge
against a false alarm.

**Architecture principle to hit that bar — and it's just good
engineering regardless:** keep the core logic (parsing rules,
frontmatter generation, GitHub API calls) as a plain, host-agnostic
module with zero Cloudflare-specific code in it. Treat email ingestion
and the deployment runtime as thin, swappable adapters around that
core. This shrinks the genuinely Cloudflare-specific surface area down
to two things: (1) how email is received — Cloudflare Email Routing vs.
Postmark/SendGrid/Mailgun inbound parsing, (2) where the function runs
— Workers vs. Vercel Functions/Lambda/etc. Everything else is portable
JS/TS talking to GitHub's API.

**Documentation plan:** one README for the portable core, plus short
per-platform guides covering just the ingestion + deployment adapter —
Cloudflare first, since it's what's actually running. Each guide only
needs to explain the thin adapter layer, not re-derive the whole
system.

**Community engagement path (confirmed via the repo itself):** the
README explicitly invites PRs adding real sites to its showcase list,
and explicitly invites new discussion threads for ideas that haven't
been raised before. Plan: a showcase PR listing nickhart.com and
weishart.com as real sites built on the template, and a discussion
thread (or the launch post itself, linked in) once the tool is built
and working.

---

## 11. Related, separate project: shared CI checks across the site repos

Complementary to post-inbox, not part of it — this should run on *any*
PR to these repos regardless of how the post was created (post-inbox,
the GitHub web editor, or a direct push).

- **Tag linting** (not auto-tagging — deferred): catches accidental tag
  fragmentation rather than suggesting tags from scratch. Normalize
  every existing tag (lowercase, strip punctuation/hyphens/spaces) and
  compare against the new post's tags — a normalized match with a
  different raw string ("next-js" vs "nextjs") is a strong signal to
  flag. Edit-distance fuzzy matching (e.g. `fastest-levenshtein`) can
  layer on top later for typos that don't normalize the same way, but
  isn't needed for a first version. Source of existing tags: scan
  existing posts' frontmatter directly, not a separately maintained
  list. Advisory only, same as spellcheck — a new tag might be
  genuinely intentional.
- **Spellcheck**: `cspell`, markdown-aware, with a custom dictionary
  from day one (Weishart, PuttPutt, TSudoku, Boom Boxing, Prologue, and
  other proper nouns that would otherwise flag constantly). Advisory —
  a PR comment, not a blocking check, given how false-positive-prone
  spellcheckers are.
- **Frontmatter/schema validation**: checks `date` parses, `tags` is
  really an array, required fields are present, and any referenced
  image actually exists in the repo. This one *should* block the PR —
  malformed frontmatter can break the site build, not just look messy.
- **Markdown style linting**: `markdownlint` for heading structure,
  trailing whitespace, etc. — cosmetic, advisory-only.

**Architecture note:** all three sites share the identical stack, so
this should be a GitHub Actions *reusable workflow* defined once
(alongside `post-inbox` or in a dedicated `.github` repo under
TeamNickHart), not three separately-maintained CI configs.
