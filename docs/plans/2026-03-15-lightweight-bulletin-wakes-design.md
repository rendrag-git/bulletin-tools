# Lightweight Bulletin Wakes — Design

**Date:** 2026-03-15
**Issues:** #1, #2, #3, #4, #5

## Problem

Bulletin responses spawn full agent sessions via `sessions_spawn`, loading complete agent context (~47k tokens) for work that amounts to "read a paragraph, write a paragraph." Combined with race conditions in the spawn-lock mechanism and unthrottled subagent completion announcements, a single 3-subscriber bulletin generates 6+ full sessions and up to 24 DM notifications.

## Decision

Replace `sessions_spawn` with the Gateway cron system's `agentTurn` payload, which supports `lightContext: true` (loads only SOUL.md/IDENTITY.md, skips MEMORY/AGENTS/CONTEXT). Jobs execute immediately via `cron.run(id, "force")` with `deleteAfterRun: true`.

## Approach: Gateway Method + CronService

The bulletin plugin registers a custom Gateway method (`bulletin_wake`) via `api.registerGatewayMethod()`. The handler has direct access to `context.cron` (`CronService`) and creates an immediate one-shot job for each subscriber.

### Why not alternatives?

- **CLI shelling out (`openclaw cron add`):** Fragile path resolution, output parsing, CLI startup overhead per call.
- **Direct Anthropic API:** Loses agent identity resolution, tool registration, session tracking. Reimplements what OpenClaw already does.
- **`sessions_send` (inject into live session):** Derails in-progress work, confuses model about current task, requires session discovery.

## Wake Mechanism

The plugin registers `bulletin_wake` via `api.registerGatewayMethod()`. When a bulletin needs subscriber responses, it creates a cron job via `context.cron.add()` then immediately executes it via `context.cron.run(job.id, "force")`.

Job shape:

```typescript
{
  name: "bulletin-{bulletinId}-{agentId}",       // deterministic = idempotent
  agentId: agentId,
  enabled: true,
  deleteAfterRun: true,
  schedule: { kind: "at", at: new Date().toISOString() },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: {
    kind: "agentTurn",
    message: taskPrompt,
    lightContext: true,
    thinking: "low",
    timeoutSeconds: 60,
  },
  delivery: { mode: "none" },
}
```

Idempotency: before creating, check `context.cron.list()` for an existing job with the same name. If it exists and hasn't run yet, skip.

Critique rounds use the same mechanism with a different label: `"bulletin-{bulletinId}-{agentId}-critique"`.

## Hook Simplification

- **`before_agent_start`:** Becomes passive — appends "you have N unresponded bulletins" notice. No spawning.
- **`agent_end`:** No more spawning sessions for normal bulletins. Waking happens at post-time.
- **`before_message_write`:** Delete entirely. Only existed to suppress `subagent_announce` from `sessions_spawn`.

## Notification Refactoring

Extract all Discord API calls (8+ scattered locations) into a single `notify(channel, message, threadId?)` function. One choke point instead of eight.

Implement `closedNotify`: when `closeBulletin()` fires and `closedNotify` is set, call `notify()` with a synthesized summary of all responses.

Remove raw `fetch()` Discord call from `bulletin-db.ts` — notification responsibility moves to `index.ts`.

Mark `notify()` with `// TODO: replace with openclaw message tool` for future channel-agnostic migration.

## Files Modified

1. **`index.ts`** — Gateway method, wake function, notify wrapper, hook simplification, closedNotify implementation
2. **`lib/bulletin-db.ts`** — Remove raw Discord fetch, add closedNotify to Bulletin type, return closedNotify from closeBulletin
3. **`~/.openclaw/bin/bulletin-post`** — Replace wakeAgentViaGateway with `openclaw cron add --at "+0s" --light-context`

## Code Deleted

- `wakeAgentViaGateway()` (~80 lines)
- Spawn-lock functions: `readLock()`, `writeLock()`, lock constants (~40 lines)
- `pendingAcks` Map and tracking logic (~20 lines)
- `before_message_write` suppression hook (~25 lines)
- Raw Discord `fetch()` in bulletin-db.ts (~15 lines)
- `.locks/` directory concept

## Issue Resolution

| Issue | Resolution |
|-------|-----------|
| #1 excessive sessions | `lightContext: true` + isolated cron job, not `sessions_spawn` |
| #2 DM flood | No `subagent_announce` — cron jobs don't notify parent |
| #3 duplicate spawns | Deterministic job name + `cron.run(id, "force")` = no race window |
| #4 closedNotify unused | Implemented via `notify()` on bulletin close |
| #5 Discord coupling | Single `notify()` choke point, swappable when OpenClaw message tool is ready |
