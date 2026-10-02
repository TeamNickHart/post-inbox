# How post-inbox was built

Reference notes for a blog post. Raw material, not a draft — the quotes are
pulled verbatim from the session transcripts so the voice is yours, not a
paraphrase.

**The project:** a Cloudflare Worker that turns an email into a draft blog post
pull request with a live preview, for three sites and several family members.
Built 9–27 September 2026 with Claude Code. 57 commits, 310 tests, one runtime
dependency.

---

## How it started

One line:

> please read the post-inbox-design.md, ask me any questions and let's get
> started

The design doc already existed, which mattered more than it sounds. It had
opinions about architecture — a host-agnostic core with thin adapters, so the
Worker could be swapped for something else — and those opinions held for the
whole project.

The first reply was a question about Node versions, and your answer set the tone
for everything after:

> also is Node 20 the right version to target? now would be the ideal time to
> change it.

Then the scope, in your words:

> I want a POC deployable worker that will test the basic functionality. let me
> email a post and create a draft on nickhart.com. we will do all the multi-site
> support and rigorous security for our MVP. we'll save the image support for
> post-MVP

Three phases, named up front, and they held. Worth noting what you *didn't*
defer: SPF/DKIM checking and the sender allowlist went in from the start, even
though the rest of "rigorous security" was explicitly MVP work.

---

## The shape of the collaboration

### You set direction; the work happened in between

A recurring pattern: you'd name a goal, go and do something else, and come back
to review.

> ok I have some testing to do when I have time later. in the meantime could you
> start a branch and begin the image and attachment work? let's not worry about
> converting/resizing images just yet--let's just see if we can get it
> functional.

And the thinking-ahead that made the architecture hold:

> keep in mind we the plan to eventually support the "reply to append"
> feature--we could attach more media.

That one sentence is why attachment numbering takes a `startIndex` parameter
that nothing uses yet.

### You tested; the machine couldn't

This was the real division of labour, and it was load-bearing. Only you could
send email from an iPhone, from iOS Mail, from the Gmail web composer, from the
Photos share sheet. Dozens of messages are variations on:

> sending portrait email...

> ok copied `portrait\ test.eml` to the scratchpad

> ok take a look at `Apple\ Mail\ test.eml` in scratchpad

Those `.eml` files were the single most valuable artifact in the project. Real
mail from real clients, which is how we learned that Gmail reports
`disposition: "attachment"` for *both* an embedded and an attached image, so
placement had to key off `multipart/related` instead.

And occasionally:

> oh shoot that was landscape. I'm an idiot. probably time to take a break
> tonight

### You pushed back on complexity, twice decisively

The image pipeline grew a manifest, an originals directory, a regeneration
strategy and a bot pushing converted files back to the PR branch. Then:

> am I making this too complex? I just want something simple. adding manifests,
> complex pushes... maybe we should commit the originals, generate the converted
> versions as part of the build

> we can always optimize this and make it fancier later. I just want something
> that works for a small personal blog

That killed the whole subsystem. It turned out the blog template already pipes
every image through `next/image`, so resizing and modern formats were free —
the elaborate plan was solving a problem that didn't exist.

The second pushback was about process rather than code:

> I don't want per-repo copies of the working workflow. I want to keep the
> working one in jennyweis as a reference implementation and a backup. I want to
> build out the bisected workflow in the shared .github repo, and use it in
> weishart and get it working there, then move it to nickhart, make sure it
> works there, then replace the one on jennyweis with the shared workflow. this
> is the plan

A rollout order, stated once, after a debugging session had produced a
convenient-but-wrong shortcut.

### You caught the privacy problem

The one that mattered most:

> before we commit this... we're not committing my specific website config info
> to a public project are we?

It was about to. The fix was gitignoring the real config, adding a documented
example, and a `check:secrets` script. Then:

> ugh, we need to be better about privacy. [my address] is fine--that is
> all over the repo. let's remember to use example URLs and email addresses in
> all documentation. I think I'd like to scrub the git history even though this
> is a pain.

The history got scrubbed with `git filter-repo`. And later, when the same
concern came up about a different file, you drew the line precisely:

> re: privacy, those same email addresses are already in the authorsBySender
> list. that ship has sailed my friend. centralize the config, and be smart
> about setting secrets and other derived config from the primary sites.jsonc

Worth noting for the post: the privacy instinct recurred at the very end too,
on the last feature. "wait are we hardcoding these pillar values into
post-inbox?" — they weren't, but the documentation implied they were, and that
impression was itself the problem.

### You turned annoyances into architecture

When mail-client differences started piling up:

> ugh so if we have to encode mail client specific rules (gmail, apple mail,
> etc...) and even platform/browser variants (iOS vs macOS, Safari vs Chrome)
> then we need a way to organize these and use a generic architecture for
> supporting different mail clients on different platforms

That became a deliberately client-agnostic placement cascade — placeholder,
then mention, then append — with logging of which rule fired, so real mail tells
us whether the cascade keeps holding instead of guessing at a client matrix up
front.

Similarly, config sprawl became a principle:

> let's keep an eye out for other ways to centralize config info and make use of
> pnpm to set secrets and other derived config info when we deploy

---

## Challenges, and what they cost

### The one that cost most of a day

A notification email arrived with this where the pull request link should be:

> Pull request: {"message":"Resource not accessible by integration",
> "documentation_url":"...","status":"403"}

Two separate bugs. First, `gh api` writes its errors to **stdout** and a
`|| true` swallowed the exit code, so a JSON error blob passed an emptiness
check and got emailed as a link. Second, the actual 403: a top-level
`permissions:` block in a caller workflow **does not reach** a `workflow_call`
job, so the token silently fell back to the repo default.

The log had said so the whole time, in a line nobody read:

```
Contents: read
Metadata: read
Packages: read     ← no PullRequests
```

Six wrong diagnoses preceded the right one. What broke the loop was a five-cycle
bisection — adding one step back at a time until the failure reappeared —
after you said:

> something is stuck--possibly both you and github

### The HEIC problem, reopened and reversed

HEIC was refused early on, for a documented reason: a Worker can't run native
binaries, so no conversion was possible. Weeks later you reopened it:

> ok now I think we probably still need to figure out a way to reliably support
> HEIC images, because gmail from iOS attaches them as HEIC. let's consider some
> creative ways to do it.  github runners? I know we have trouble doing it as
> part of the PR... could it be a post-PR step? make a follow-up commit on the
> branch?
>
> or part of the post-onbox handler?
>
> an API on a server hosted by vercel (possibly an existing site)?

Four options, and a request to look at how others had solved it. Testing them produced two surprises:

1. **Prebuilt `sharp` cannot decode HEIC anywhere.** It reads the container then
   fails `bad seek`, because HEVC is patent-encumbered and excluded from the
   binaries. So the documented fallback plan — a GitHub Action with `sharp` —
   was never viable either.
2. **Cloudflare Images had added HEIC support in July 2025**, on the platform
   the Worker already ran on. It also strips EXIF and bakes rotation into
   pixels, which is better than the hand-rolled EXIF rebuilder it replaced.

The thing that made it testable was your own discovery, after two dead ends:

> Maybe I need to attach the HEIC from files. Seems like Gmail is
> auto-converting to jpeg. Or try from iOS's mail app

That was right. iOS Gmail converts HEIC→JPEG on both paths a person would
naturally use; only a Files-app attachment survives. Three test emails mapped it:

| How it was sent | What arrived |
|---|---|
| Photos share sheet → Gmail | rejected — HTML-only, no plaintext body |
| Gmail, attach from Photos | re-encoded to JPEG by Gmail |
| **Gmail, attach from Files** | a real `.heic` — converted ✅ |

### The bug that was shipped *and documented as fixed*

Worth including, because it's the most honest thing in the project. The HEIC
work added a pin so the shared notification script couldn't drift from the
workflow running it:

```yaml
ref: ${{ github.job_workflow_sha }}
```

That context **does not exist**. It resolved to an empty string, the checkout
fell back to the default branch, and the pin pinned nothing — the exact problem
the change claimed to fix. Five production runs printed
`Shared script pinned to: <empty>` before anyone looked.

Two things caught it: a linter (`actionlint`) flagging an undefined property,
and a guard added alongside the pin that echoed its own input. The fix needed a
real run to settle, because the docs were wrong twice:

```
github.job_workflow_sha:  <empty>                 ← does not exist
github.workflow_sha:      the CALLER's commit
github.workflow_ref:      the CALLER's repo
```

No context gives a called workflow its own version. The caller has to pass it.

### The quieter class of bug: checks that checked nothing

Five of these, and they're the most transferable lesson:

- `check:secrets` read the **staged** diff, which is empty on a CI runner — it
  reported "Checked 0 staged file(s)" and passed unconditionally
- `cspell` **silently skips files outside its working directory**, so it appeared
  to find zero unknown words across 13 posts
- the MDX check shipped to three repos with a `paths:` filter that excluded the
  very pull request adding it, so it had never once run
- a `deployment_status` run loads the workflow from the **branch**, not `main`,
  so a "verified" fix had tested the old file
- an empty commit produces no Vercel build at all, so it can't trigger anything

Each looked like success. The habit that came out of it: make a new check **fail
on purpose** before trusting it, and have it print its own denominator —
"Checked 59 tracked files", "Found 12 .mdx files". A zero there is the tell.

### A required check that blocks forever

After branch protection went on, a README-only pull request came back
`mergeable=MERGEABLE state=BLOCKED` — every visible check green, nothing
failing, no way to merge. The required check had a `paths:` filter, didn't
match, never ran, and so never reported. A required check that doesn't run is
invisible rather than red.

---

## Where it ended up

| | |
|---|---|
| Email or HTTPS → draft pull request | three sites, routed by inbound address |
| Sender auth | SPF/DKIM + allowlist, with a subject-token fallback |
| Attachments | images and PDFs, GPS and device metadata stripped at upload |
| HEIC | converted to JPEG in the Worker, EXIF gone, rotation baked in |
| Notifications | Resend, with a deep link to the post and its pull request |
| Signature stripping | the `-- ` delimiter, plus a fallback for clients that send none |
| Site-specific frontmatter | declared per site, so nothing site-specific is in code |
| CI | all five repos, branch protection, shared reusable workflows |

Three sites, 310 tests, one runtime dependency (`postal-mime`).

---

## Threads worth pulling for the post

**The design doc did real work.** "Host-agnostic core, thin adapters" was
written before any code and never bent, including when conversion wanted to live
in the Worker. Features got re-litigated; the architecture didn't.

**The machine can't test email.** Every real discovery came from an `.eml` file
or a sent message — the `multipart/related` finding, the HEIC client matrix, the
signature with no delimiter. A faster model wouldn't have found any of them.

**"Am I making this too complex?" was the highest-leverage question asked.** It
deleted a subsystem that was solving a non-problem. Worth asking more often than
feels comfortable.

**Confident and wrong is the failure mode to watch.** The permissions bug took
six wrong diagnoses; the pin bug shipped with documentation claiming it worked.
Both were caught by evidence — a log line, a linter, a guard that printed its
input — not by reasoning harder.

**Privacy needs asking about, repeatedly.** Three times across the project:
nearly committing the real config, a leaked address in a pushed file, and
documentation that implied one site's taxonomy was built into a shared tool. The
instinct to ask "wait, is this public?" caught all three.

**A signature leaked a real email address into a public repo on three of four
test posts** before anyone noticed, because the refusal message that was supposed
to warn about it only ever appeared in the pull request body — which nobody
reads when the notification says the post is ready.
