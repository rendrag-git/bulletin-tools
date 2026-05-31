# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shared Instructions

Read `AGENTS.md` first. It is the shared source of truth for tracker routing, guidepost discipline, goal-loop conventions, verification, and project-specific engineering rules.

`GUIDEPOST.md` is the guarded project scope charter. Do not edit it without explicit user approval.

Linear is canonical for issues, PRDs, blockers, acceptance, and long-running execution state. Use the `bulletin-tools` Linear project and the routing docs in `docs/agents/`.

Claude `/goal` is a stop condition evaluated from transcript-visible state. End each turn with the acceptance or progress evidence needed by the evaluator. Do not enter Plan Mode mid-loop if it stops continuation.

## Agent Skills

### Issue Tracker

Issues are tracked through Linear MCP in the `bulletin-tools` project. See `docs/agents/issue-tracker.md`.

### Triage Labels

Use the default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain Docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.

## What This Is

An OpenClaw plugin (`@openclaw-local/bulletin-tools`) that provides a multi-agent bulletin board system. Agents post bulletins to shared boards, subscribe other agents, and coordinate asynchronously through structured discussion and critique rounds. The plugin registers MCP tools that agents call to interact with bulletins, and uses OpenClaw lifecycle hooks to auto-wake agents when they have pending bulletins.

## Development

```bash
npm install          # install deps (better-sqlite3)
```

Run `npm run build` before installing into OpenClaw; package installs use `dist/index.js`. Run `npm test` for the current smoke tests.

## Architecture

**Two files, two layers:**

- `index.ts` — Plugin entry point. Registers three tools (`bulletin_respond`, `bulletin_critique`, `bulletin_list`) via `api.registerTool()` and three lifecycle hooks (`before_agent_start`, `agent_end`, `before_message_write`). Contains all Discord notification logic, spawn-lock management, and completion/escalation workflows.

- `lib/bulletin-db.ts` — SQLite persistence layer using `better-sqlite3`. All DB access is synchronous. Manages schema creation, CRUD, FTS (full-text search), read cursors, and audit logging.

**Runtime data location:** `$OPENCLAW_HOME/mailroom/bulletins/bulletins.db` (SQLite with WAL mode), defaulting to `~/.openclaw/mailroom/bulletins/bulletins.db`.

## Key Concepts

**Protocols** determine how a bulletin resolves:
- `advisory` / `consensus` — all subscribers must respond, then a critique round opens automatically
- `majority` — closes as soon as >50% align
- `fyi` — informational only

**Rounds:** Bulletins progress `discussion` → `critique`. Round transitions and bulletin closes use atomic SQL updates (`UPDATE ... WHERE status = 'open'`) to prevent race conditions when multiple agents respond concurrently.

**Agent waking:** Bulletin wakes use `api.runtime.subagent.run()` with deterministic bulletin session keys. The plugin also registers `bulletin_wake` and an authenticated `/bulletin/wake` HTTP route as compatibility/fallback paths. Bulletin sessions use the `agent:bootstrap` hook to keep only minimal identity files.

**Discord integration:** Responses, critiques, dissent alerts, and resolution notices are posted to Discord threads. Config lives in `$OPENCLAW_HOME/mailroom/bulletin-config.json`. Bot tokens resolve via `${ENV_VAR}` syntax against `process.env`, `$OPENCLAW_HOME/secrets.json`, and `$OPENCLAW_HOME/.env`.

## FTS Content-Sync Warning

The FTS tables (`bulletins_fts`, `responses_fts`) use `content=` mode — they do NOT auto-update. Every INSERT/UPDATE to `bulletins` or `bulletin_responses` must include a corresponding FTS insert/delete within the same transaction. Forgetting this causes search results to go stale or crash.

## External Dependencies

- Gateway API at `127.0.0.1:{port}` (default 18789) for `/bulletin/wake` fallback calls.
- Discord notifications (`lib/discord-notify.ts`) are inlined. Long-term these should go through OpenClaw's message tool so the plugin isn't Discord-specific.
