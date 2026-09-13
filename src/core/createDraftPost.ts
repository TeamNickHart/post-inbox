import { GitHubClient } from './github.ts'
import { formatDate, renderPost, slugify } from './markdown.ts'
import type { DraftPostRequest, DraftPostResult, SiteConfig } from './types.ts'

/**
 * Create a draft post as a branch + commit + pull request.
 *
 * This is the one function both the email handler and the HTTPS handler
 * call, and the only place that drives the GitHub client. It never
 * publishes: the post is committed with `draft: true` on its own branch
 * and left as an open PR for review.
 */
export async function createDraftPost(
  request: DraftPostRequest,
  site: SiteConfig,
  github: GitHubClient,
): Promise<DraftPostResult> {
  const { owner, repo, baseBranch, contentPath, extension } = site

  const slug = slugify(request.title)
  const date = formatDate(request.date)
  const path = `${contentPath}/${slug}${extension}`
  const content = renderPost(request)

  // Include the date so re-sending the same title later doesn't collide
  // with a branch still open from a previous attempt.
  const branch = await uniqueBranchName(github, owner, repo, `post-inbox/${date}-${slug}`)

  const parentSha = await github.getBranchHead(owner, repo, baseBranch)
  // Attachments ride in the same commit as the post, so the PR is complete in
  // one revision rather than showing a post that references files not yet
  // present.
  const files = [{ path, content }, ...(request.extraFiles ?? [])]
  const commitSha = await github.createCommit(
    owner,
    repo,
    parentSha,
    files,
    `Add draft post: ${request.title}`,
  )
  await github.createBranch(owner, repo, branch, commitSha)

  const pullRequest = await github.createPullRequest(owner, repo, {
    title: `Draft: ${request.title}`,
    head: branch,
    base: baseBranch,
    body: pullRequestBody(request, path),
  })

  return {
    branch,
    path,
    commitSha,
    pullRequestUrl: pullRequest.html_url,
    pullRequestNumber: pullRequest.number,
  }
}

/**
 * Find a branch name that isn't taken, appending `-2`, `-3`, … if the
 * preferred name already exists.
 */
async function uniqueBranchName(
  github: GitHubClient,
  owner: string,
  repo: string,
  preferred: string,
): Promise<string> {
  if (!(await github.branchExists(owner, repo, preferred))) return preferred

  for (let suffix = 2; suffix <= 20; suffix++) {
    const candidate = `${preferred}-${suffix}`
    if (!(await github.branchExists(owner, repo, candidate))) return candidate
  }
  throw new Error(`Could not find an unused branch name based on ${preferred}`)
}

/**
 * The pull request description.
 *
 * Deliberately names no email address. `request.author` is the sender's real
 * address, and a pull request body is permanent, readable by every
 * collaborator, and quoted into notification emails and Actions logs — so it is
 * the wrong place for one even on a private repo. The author *name*, when the
 * site resolved one, is already in the post's frontmatter and is enough for a
 * reviewer to know whose post this is.
 */
function pullRequestBody(request: DraftPostRequest, path: string): string {
  const attachments = request.extraFiles ?? []
  const rejected = request.rejectedAttachments ?? []
  const converted = request.convertedAttachments ?? []

  return [
    'Draft post created by [post-inbox](https://github.com/TeamNickHart/post-inbox).',
    '',
    `- **File:** \`${path}\``,
    `- **Date:** ${formatDate(request.date)}`,
    ...(request.authorFile ? [`- **Author:** ${request.authorFile}`] : []),
    ...(attachments.length > 0
      ? [
          `- **Attachments:** ${attachments.length} committed alongside the post` +
            // A conversion is a success, so it rides on the attachments line
            // rather than becoming a warning of its own.
            (converted.length > 0
              ? ` (${converted.length} converted from ${[...new Set(converted.map((item) => item.from))].join(', ')})`
              : ''),
        ]
      : []),
    '',
    // Listed rather than logged: the sender is not watching the Worker's logs,
    // and a dropped attachment they never hear about is the failure this avoids.
    ...(rejected.length > 0
      ? [
          '> [!WARNING]',
          `> ${rejected.length === 1 ? 'An attachment was' : 'Some attachments were'} not committed:`,
          '>',
          ...rejected.map((item) => `> - \`${item.filename}\` — ${item.reason}`),
          '',
        ]
      : []),
    'Review the Vercel preview, then merge to publish.',
  ].join('\n')
}
