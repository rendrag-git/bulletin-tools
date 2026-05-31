# AGENTS.md

Shared instructions for agents working in this repository.

## Project

`bulletin-tools` is an OpenClaw plugin for structured multi-agent deliberation. It lets agents post bulletins, subscribe other agents, collect `align`, `partial`, or `oppose` positions, run critique rounds, and route closure summaries.

Published distribution matters here: `rendrag-git/bulletin-tools` is intentionally public because the plugin is published on ClawHub. Treat GitHub as code hosting and PR review, not the canonical issue tracker.

## Agent Skills

### Issue Tracker

Issues, PRDs, blockers, acceptance, and long-running execution state are tracked through Linear MCP in the `bulletin-tools` project. See `docs/agents/issue-tracker.md`.

### Triage Labels

Use the default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain Docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.

## Project Guidepost

`GUIDEPOST.md` is the permission-guarded project scope charter. Read it after setup, after durable planning or grilling decisions, before major planning pivots, and after completing any major feature, vertical slice, milestone, or goal-loop acceptance item.

Do not edit `GUIDEPOST.md` without explicit user approval. If completed work implies a scope change, stop and report the proposed change instead of quietly updating the guidepost.

## Goal-Loop Conventions

Linear is canonical for active goal state. A Linear gatekeeper issue should own the live gate, active acceptance target, blockers, next checkpoint, and completion state when a long-running goal exists.

`GOAL.md` is a local helper for repo-side conventions, routing pointers, and evidence locations. It is not the canonical tracker and not a duplicate Linear work queue.

At the start of each continuation, re-read the Linear project or gatekeeper issue, `GOAL.md`, and `GUIDEPOST.md`. If Linear and `GOAL.md` disagree, Linear wins. If durable scope is unclear, `GUIDEPOST.md` wins unless the user explicitly approves a change.

Keep `/goal` commands stable and free of Linear issue numbers, issue URLs, PR numbers, and ticket IDs. Put mutable identifiers in Linear, `GOAL.md`, or `docs/agents/issue-tracker.md`.

Do not call a goal complete until the canonical tracker and local evidence both show done.

## Verification Discipline

Verify before claiming done. Run the relevant test, audit, runtime probe, log check, or diff and report the result. If there is no automated test for the changed surface, say so and use the narrowest meaningful manual/runtime verification.

Two failed fix attempts means stop, reassess, and record the blocker. Do not thrash.

Do not use transcript logs as completion evidence. Use repo files, test output, runtime logs, Linear state, or other durable artifacts.

## Project-Specific Engineering Rules

- Discord is the only currently implemented and tested notification platform. Other platform branches are stubs or flat-message fallbacks until proven otherwise.
- Runtime config lives under `~/.openclaw/mailroom/`, especially `bulletin-config.json` and `agent-groups.json`.
- Bulletin runtime state is stored in SQLite at `~/.openclaw/mailroom/bulletins/bulletins.db`.
- Keep `bulletins_fts` and `responses_fts` synchronized inside the same transaction as their source table writes.
- Preserve atomic SQL transitions for round changes and bulletin closes.
- Preserve the ternary response model: `align`, `partial`, and `oppose`. `partial` must carry reservations.
- Preserve critique-round semantics for `advisory` and `consensus` protocols.
- Channel-level permissions are the privacy boundary. The plugin does not enforce private ACLs beyond subscriber routing.
