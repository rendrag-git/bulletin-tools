# Issue Tracker: Linear

Issues and PRDs for this repo live in Linear, not GitHub's issue tracker or repo markdown files.

Linear is the canonical acceptance, blocker, and execution state for this repo. `GOAL.md`, when present, is only a local helper for repo-side conventions and evidence pointers. `GUIDEPOST.md` owns durable project scope and requires explicit approval to change.

Repository: rendrag-git/bulletin-tools
Codex environment: bulletin-tools
Default branch: main

Linear project: `bulletin-tools`
Linear project URL: https://linear.app/rendrag/project/bulletin-tools-bc240d33e0c1
Linear team: Rendrag

GitHub URL: https://github.com/rendrag-git/bulletin-tools
GitHub visibility: public, intentionally, because this plugin is published on ClawHub.

Manual Codex environment gate: create or confirm environment `bulletin-tools` for `rendrag-git/bulletin-tools` at https://chatgpt.com/codex/settings/environments.

Do not claim the Codex environment exists until the user confirms it or a reliable Codex-side verification is available.

## Codex Routing

Every Codex-ready Linear issue should include:

```text
Repo: rendrag-git/bulletin-tools
```

When tagging Codex in Linear, use:

```text
@Codex work on this in rendrag-git/bulletin-tools.
```

Keep `/goal` commands stable and free of Linear issue numbers, issue URLs, PR numbers, and ticket IDs. Put mutable identifiers in Linear, `GOAL.md`, or this file.

## Gatekeeper Issues

Create a Linear gatekeeper issue only when an active long-running goal exists. The gatekeeper issue owns the live gate, active acceptance target, blockers, next checkpoint, and completion state.

Do not create placeholder issues just to fill tracker structure.
