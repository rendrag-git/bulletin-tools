# Goal

Linear is the canonical execution tracker for this repo once configured. `GOAL.md` is a local helper for repo-side goal-loop conventions, routing pointers, and evidence locations. It is not the project scope charter and not a duplicate Linear work queue.

Use `GUIDEPOST.md` for the project north star, durable scope boundaries, non-goals, non-negotiables, and locked user decisions.

## Routing

Repository: rendrag-git/bulletin-tools
Codex environment: bulletin-tools
Default branch: main

GitHub: https://github.com/rendrag-git/bulletin-tools
Linear project: https://linear.app/rendrag/project/bulletin-tools-bc240d33e0c1
Linear team: Rendrag

This GitHub repo is intentionally public because `bulletin-tools` is published on ClawHub. GitHub is code hosting and PR review only unless the user explicitly chooses otherwise.

Manual Codex environment gate: create or confirm environment `bulletin-tools` for `rendrag-git/bulletin-tools` at https://chatgpt.com/codex/settings/environments.

## Canonical Surfaces

- Linear project `bulletin-tools`: issues, PRDs, blockers, acceptance, ownership, and long-running execution state.
- `GUIDEPOST.md`: durable project scope and locked decisions.
- `docs/agents/issue-tracker.md`: tracker and Codex routing conventions.
- `docs/agents/triage-labels.md`: label vocabulary.
- `docs/agents/domain.md`: domain map for agents.
- `AGENTS.md`: shared agent rules.
- `CLAUDE.md`: Claude Code-specific overlay.

## Evidence Locations

- Source: `index.ts`, `lib/bulletin-db.ts`, `bin/bulletin-post`
- Package metadata: `package.json`, `openclaw.plugin.json`, `SKILL.md`
- User docs: `README.md`
- Design and implementation notes: `docs/plans/`
- Runtime config: `~/.openclaw/mailroom/bulletin-config.json`, `~/.openclaw/mailroom/agent-groups.json`
- Runtime state: `~/.openclaw/mailroom/bulletins/bulletins.db`
- Audit logs: `~/.openclaw/mailroom/bulletins/audit.log`; `lib/bulletin-db.ts` also writes `~/.openclaw/mailroom/bulletins/bulletins.log`

## Goal-Loop Rules

- Re-read Linear, this file, and `GUIDEPOST.md` at the start of each continuation.
- Keep live gates, blockers, next checkpoints, and completion state in Linear.
- Keep mutable issue IDs and PR IDs out of `/goal` commands.
- Verify before marking acceptance complete.
- After two failed fix attempts, stop and record the blocker in Linear.

## Setup State

- Linear project created: `bulletin-tools`
- Repo routing recorded: yes
- Codex environment: manual gate pending user confirmation
- Dedicated root/gatekeeper issue: not created; create only when there is an active long-running goal
