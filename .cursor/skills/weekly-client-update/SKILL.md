---
name: weekly-client-update
description: Draft a weekly client update email for the ABE chatbot project. Use when the user asks to write, draft, or prepare a weekly update, client email, status report, or progress email for Dmitri/OSD.
---

# Weekly Client Update Email

Draft a weekly progress email to the client (Dmitri at OSD) summarizing what was done and what's needed from them.

## Step 1: Gather Changes

Run these commands to understand what happened this week:

```bash
# Git log for the past 7 days (adjust date range if user specifies)
git log --since="7 days ago" --pretty=format:"%h %ad %s" --date=short --no-merges

# Detailed diff stats for each commit
git log --since="7 days ago" --no-merges --format="%h %s" --stat
```

For each commit, read the full message and diff to understand the actual changes:

```bash
git show <hash> --stat --format="%B"
```

## Step 2: Check the Modernization Plan

Read `.cursor/plans/abe_full_modernization_plan.md` and cross-reference:
- Which plan items were completed this week?
- Which items are in progress?
- Are there any blocked items that need client input?

## Step 3: Check for Open Items Needing Client Action

Look for anything blocked on the client by:
- Searching recent git messages and plan for "blocked", "waiting", "need", "pending"
- Asking the user if there are any outstanding items they need from the client

## Step 4: Draft the Email

Use this template and tone. Keep it concise, professional, and non-technical where possible. Translate infrastructure changes into business value (e.g., "added point-in-time recovery" becomes "data can be restored if anything goes wrong").

```
Hi Dmitri,

Quick update on the progress we made on ABE this past week. [One sentence framing the theme of this week's work.]

[Category 1 — e.g., Bug fixes]
- [Plain-English description of what was fixed and why it matters]
- [Another fix]

[Category 2 — e.g., Infrastructure & security improvements]
- [Plain-English description of what changed and the benefit]
- [Another improvement]

[Category 3 — if applicable, e.g., Chatbot quality, New features, UI improvements]
- [Description]

Important links
- GitHub Repo: https://github.com/The-Burnes-Center/ai4impact-abe-chatbot-osd
- Non-Prod Deployment Link: https://d9sp8dj4m42ru.cloudfront.net/

[Optional: "Items we need your support on" section if there are blockers]
- [Specific ask with context]

Let us know if you have any questions or if you'd like a walkthrough of any of the changes.

Best,
Dhruv and Anjith
```

## Writing Guidelines

- **Categories**: Group changes into 2-4 categories. Common ones: "Bug fixes", "Security improvements", "Infrastructure improvements", "Chatbot quality improvements", "New features", "UI/UX improvements", "Admin dashboard". Combine or split as needed — don't force categories with only one bullet.
- **Tone**: Professional but approachable. First-person plural ("we"). No jargon without explanation.
- **Translate tech to value**: The client is not a developer. Say what the change *does for them*, not how it works internally. For example:
  - "Enabled CDK Nag" → "Enabled automated compliance checking against AWS best practices"
  - "Added X-Ray tracing" → "Added distributed tracing for better debugging and monitoring"
  - "Refactored Stacks to Constructs" → omit (internal refactor, no client impact) or fold into a broader bullet
- **Skip internal-only changes**: Don't mention `.cursorignore`, modernization plan updates, dev tooling changes, or pure refactors with no user/ops impact — unless they enable something the client cares about.
- **Verify claims**: Before including a bullet point, confirm it actually happened by checking the git diff. Don't overstate (e.g., don't say "all functions" if only some were changed).
- **"Items we need your support on"**: Only include if there are genuine blockers. Be specific about what you need and why.
- **Sign-off**: Always "Dhruv and Anjith" unless the user specifies otherwise.

## Step 5: Review with the User

Present the draft and ask the user:
1. Is anything missing that wasn't captured in git? (e.g., meetings, research, planning)
2. Are there any items they need from the client this week?
3. Any bullets to add, remove, or rephrase?
