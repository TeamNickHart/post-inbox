# Acceptance test

**Send this email. You should get a draft PR that builds.**

If it does, post-inbox works end to end for the site you have configured: the
security checks admit you, the body survives the markdown-to-MDX
transformation, and the result compiles in the Tailwind Nextjs Starter Blog.

This is the test to run after changing the transformation pipeline, upgrading
the site template, or setting the tool up for a new site.

## The files

| File | What it is |
|---|---|
| `body.md` | The email body to send. Mail it verbatim — no wrapper, no edits. |
| `expected.mdx` | Exactly what the pipeline should commit. Diffed by `pnpm test`. |

[`rejections/`](rejections/) covers the other half: the ways a message is
*turned away*, and what the sender should see. A bounce is the only feedback a
sender gets, so a rejection that says nothing useful is indistinguishable from
the system being broken.

`body.md` exercises every markdown feature the site's MDX config supports:
plain markdown, GFM (tables with alignment, task lists, strikethrough,
footnotes), math via KaTeX, GitHub-style alerts, code titles, reference links,
and — importantly — prose that merely *looks* like syntax (`Array<int>`,
`x <5`, `{maybe}`, `<-`).

## Running it end to end

1. **Send the email.** Subject is the post title; the body is `body.md`
   verbatim.

   ```
   To: your-inbox-address
   Subject: Markdown Acceptance Test
   ```

   Add `[your-subject-token]` to the subject if your mail does not carry
   passing SPF/DKIM verdicts — see the main README.

2. **Check a PR appeared.** Titled `Draft: Markdown Acceptance Test`, on a
   `post-inbox/<date>-markdown-acceptance-test` branch.

3. **Check the preview deploy passed.** This is the real assertion: a green
   Vercel check means the generated MDX compiles. A red one means the
   transformation produced something the site cannot build.

4. **Look at the rendered preview.** The build passing only proves it
   *compiles*. Open the preview and confirm:

   - Math renders as formulas, not as visible backslashes and braces
   - Tables have borders and aligned columns
   - The `[!NOTE]`, `[!WARNING]` and `[!TIP]` blocks render as alerts
   - Code blocks are syntax-highlighted, and the one with a title shows
     `wrangler.config.js` above it
   - Footnote links jump to the notes at the bottom
   - The reference-style link works
   - `5 < 10`, `Array<int>` and `{maybe}` appear as written, with no stray
     backslashes

5. **Close the PR and delete the branch.** It is a test post, not content.

## What "it built" does not prove

A passing build means the MDX compiled. It does not mean every construct
rendered *correctly* — mangled TeX compiles fine and renders as gibberish,
which is exactly the bug that writing this test first uncovered. Step 4 is not
optional.

## Running it offline

`pnpm test` diffs the pipeline's output against `expected.mdx`, so most
regressions are caught without sending anything. That covers the
transformation; it cannot tell you whether the *site* still builds what the
transformation produces, which is what the email test adds.

After a deliberate pipeline change, regenerate the fixture and read the diff:

```bash
pnpm test:accept
git diff examples/
```

Every line of that diff is a change to what an emailed post becomes. Treat an
unexpected one as a bug, not as noise to accept.
