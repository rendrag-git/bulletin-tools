# Lightweight Bulletin Wakes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace heavyweight `sessions_spawn` bulletin wakes with lightweight cron-based agent turns using `lightContext`, eliminating spawn locks, DM floods, and duplicate spawns.

**Architecture:** Register a `bulletin_wake` Gateway method that creates immediate one-shot cron jobs via `CronService.add()` + `CronService.run()`. Extract all Discord notification calls into a single `notify()` choke point. Implement `closedNotify` summary notifications.

**Tech Stack:** OpenClaw plugin SDK (`registerGatewayMethod`, `CronService`), better-sqlite3, Node.js `child_process` (for `bulletin-post` CLI script)

---

### Task 1: Extract `notify()` wrapper

**Why first:** Every subsequent task touches notification call sites. Centralizing first means later tasks just call `notify()` instead of rewriting Discord calls.

**Files:**
- Modify: `index.ts:1-6` (imports), add `notify()` function after line 84

**Step 1: Add the `notify()` function**

Add after the `auditLog` function (line 84) in `index.ts`:

```typescript
// ── Notification choke point ─────────────────────────────────────────────
// TODO: Replace with OpenClaw message tool when available (issue #5)

interface NotifyConfig {
  botToken: string;
  escalationChannel?: string;
}

function loadNotifyConfig(): NotifyConfig | null {
  try {
    const cfgPath = join(homedir(), ".openclaw", "mailroom", "bulletin-config.json");
    if (!existsSync(cfgPath)) return null;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const botToken = resolveConfigToken(cfg.botToken) ?? process.env.RELAY_BOT_TOKEN;
    if (!botToken) return null;
    return { botToken, escalationChannel: cfg.escalationChannel };
  } catch {
    return null;
  }
}

async function notify(
  target: { channel?: string; threadId?: string },
  message: string,
): Promise<void> {
  const cfg = loadNotifyConfig();
  if (!cfg) return;
  try {
    if (target.channel) {
      await postToDiscord(target.channel, message, cfg.botToken);
    }
    if (target.threadId) {
      await postToThread(target.threadId, message, cfg.botToken);
    }
  } catch { /* best effort — never block bulletin operations */ }
}
```

**Step 2: Replace all Discord call sites in `bulletin_respond` handler**

There are 4 Discord call sites in `bulletin_respond` (lines 470-630). Replace each:

**Response posted to thread (lines 472-491):**
Replace the entire try/catch block with:
```typescript
if (threadId) {
  const posTag = position === "oppose" ? " ⚠️ **[OPPOSE]**"
               : position === "partial" ? ` ~ **[PARTIAL]**`
               : " ✅";
  const snippet = response.slice(0, 280);
  await notify(
    { threadId },
    `${posTag} **${agentId}** responded:\n> ${snippet}${response.length > 280 ? "…" : ""}`,
  );
}
```

**Majority close (lines 517-534):**
Replace with:
```typescript
const cfg = loadNotifyConfig();
if (cfg) {
  const msg = `✅ [${bulletinId}] "${updated.topic ?? bulletinId}" — majority (${alignCount}/${subscribers.length} aligned)`;
  await notify({ channel: cfg.escalationChannel }, msg);
  await notify({ threadId }, `🏁 **Resolved** — ${msg}`);
}
```

**Critique round notice (lines 547-573):**
Replace with:
```typescript
await notify(
  { threadId },
  `🔄 **Critique round open** — all ${subscribers.length} subscribers responded.\nEach subscriber should now review the discussion and submit a critique using \`bulletin_critique\`.`,
);
```
(The subscriber wake call at line 569 stays for now — it gets replaced in Task 3.)

**Dissent escalation (lines 578-630):**
Replace with:
```typescript
if (position === "oppose") {
  try {
    const cfg = loadNotifyConfig();
    if (cfg) {
      const dissenters = new Map<string, string>();
      for (const r of updated.responses) {
        if ((r as any).position === "oppose" && !dissenters.has(r.agentId)) {
          dissenters.set(r.agentId, ((r as any).body ?? "").slice(0, 100));
        }
      }
      const threshold = (() => {
        try {
          const c = JSON.parse(readFileSync(
            join(homedir(), ".openclaw", "mailroom", "bulletin-config.json"), "utf-8"
          ));
          return c.dissentThreshold ?? 2;
        } catch { return 2; }
      })();
      if (dissenters.size >= threshold) {
        const dissenterList = Array.from(dissenters.entries())
          .map(([agent, text]) => `- **${agent}**: "${text}..."`)
          .join("\n");
        const alertText = [
          `⚠️ **Oppose Alert** — Bulletin [${bulletinId}] "${updated.topic ?? bulletinId}"`,
          "",
          `${dissenters.size} of ${subscribers.length} subscribers have opposed:`,
          dissenterList,
          "",
          `Review in SQLite DB: ~/.openclaw/mailroom/bulletins/bulletins.db`,
        ].join("\n");
        await notify({ channel: cfg.escalationChannel, threadId }, alertText);
        auditLog(`ESCALATE bulletin=${bulletinId} opposes=${dissenters.size} threshold=${threshold}`);
      }
    }
  } catch (err) {
    console.error("[bulletin-tools] dissent escalation error:", err instanceof Error ? err.message : String(err));
  }
}
```

**Step 3: Replace Discord call sites in `bulletin_critique` handler**

**Critique posted to thread (lines 724-744):**
Replace with:
```typescript
if (critiqueThreadId) {
  const posTag = position === "oppose" ? " ⚠️ **[OPPOSE]**"
               : position === "partial" ? ` ~ **[PARTIAL]**`
               : " 🧐";
  const snippet = response.slice(0, 280);
  await notify(
    { threadId: critiqueThreadId },
    `${posTag} **${agentId}** critique:\n> ${snippet}${response.length > 280 ? "…" : ""}`,
  );
}
```

**Consensus close (lines 771-797):**
Replace with:
```typescript
const cfg = loadNotifyConfig();
if (cfg) {
  await notify(
    { channel: cfg.escalationChannel },
    `✅ [${bulletinId}] "${updated.topic ?? bulletinId}" — consensus reached`,
  );
  await notify(
    { threadId: critiqueThreadId },
    `🏁 **Resolved** — consensus reached after critique round.`,
  );
}
```

**Consensus fail (lines 801-826):**
Replace with:
```typescript
const cfg = loadNotifyConfig();
if (cfg) {
  const failMsg = [
    `⚠️ [${bulletinId}] "${updated.topic ?? bulletinId}" — consensus not reached.`,
    `Critique complete: ${opposeCount} oppose(s), ${partialCount} partial(s).`,
    `Review required before closing.`,
  ].join("\n");
  await notify({ channel: cfg.escalationChannel }, failMsg);
  await notify(
    { threadId: critiqueThreadId },
    `⚠️ **Consensus not reached** — ${opposeCount} oppose(s), ${partialCount} partial(s). Human review required.`,
  );
}
```

**Step 4: Remove the `* as http` import**

After Task 3 removes the last HTTP usage, remove line 5:
```typescript
import * as http from "node:http";
```
(Keep this step pending until Task 3 confirms no other HTTP usage remains.)

**Step 5: Commit**

```bash
git add index.ts
git commit -m "Extract notify() wrapper to centralize Discord calls

Replaces 8 scattered postToDiscord/postToThread call sites with a
single notify() choke point. Prepares for future channel-agnostic
migration (issue #5)."
```

---

### Task 2: Add `closedNotify` to Bulletin type and move notification to index.ts

**Files:**
- Modify: `lib/bulletin-db.ts:54-76` (Bulletin interface), `lib/bulletin-db.ts:302-333` (loadBulletin return), `lib/bulletin-db.ts:508-558` (closeBulletin)
- Modify: `index.ts` (add closedNotify handling after bulletin close calls)

**Step 1: Add `closedNotify` to the Bulletin interface**

In `lib/bulletin-db.ts`, add to the `Bulletin` interface after line 75 (`parentId`):

```typescript
  closedNotify?: string;
```

**Step 2: Return `closedNotify` from `loadBulletin`**

In `lib/bulletin-db.ts`, add to the return object at line 332 (after `parentId`):

```typescript
    closedNotify: row.closed_notify as string | undefined,
```

**Step 3: Remove raw Discord `fetch()` from `closeBulletin`**

In `lib/bulletin-db.ts`, replace lines 532-548 (the `closedNotify` callback block) with:

```typescript
    // closedNotify is now handled by the plugin layer (index.ts)
    // after closeBulletin returns, using the notify() wrapper.
```

**Step 4: Add `closedNotify` handling in `index.ts`**

After every `dbCloseBulletin()` call in `index.ts`, add summary notification. There are 3 close sites:

**Majority close (after line 516):**
After the `if (closed)` block, add:
```typescript
if (closed?.closedNotify) {
  const summary = buildCloseSummary(closed);
  await notify({ threadId: closed.closedNotify.replace("channel:", "") }, summary);
}
```

**Consensus close (after line 768):**
Same pattern.

**Stale timeout (after line 1051 and 1056):**
Same pattern, but these are synchronous contexts — wrap in a `.then()` or extract.

**Add the `buildCloseSummary` helper** in `index.ts` after the `notify` function:

```typescript
function buildCloseSummary(bulletin: ReturnType<typeof loadBulletin>): string {
  if (!bulletin) return "";
  const responses = bulletin.responses ?? [];
  const critiques = bulletin.critiques ?? [];
  const lines = [
    `📋 **Bulletin Closed** — [${bulletin.id}] "${bulletin.topic}"`,
    `**Resolution:** ${bulletin.resolution ?? "unknown"}`,
    "",
    `**Discussion (${responses.length} responses):**`,
    ...responses.map(r => {
      const pos = r.position === "oppose" ? "⚠️ OPPOSE"
                : r.position === "partial" ? "~ PARTIAL"
                : "✅";
      return `- **${r.agentId}** [${pos}]: ${(r.body ?? "").slice(0, 150)}${(r.body ?? "").length > 150 ? "…" : ""}`;
    }),
  ];
  if (critiques.length > 0) {
    lines.push("", `**Critiques (${critiques.length}):**`);
    for (const c of critiques) {
      const pos = c.position === "oppose" ? "⚠️ OPPOSE"
                : c.position === "partial" ? "~ PARTIAL"
                : "🧐";
      lines.push(`- **${c.agentId}** [${pos}]: ${(c.body ?? "").slice(0, 150)}${(c.body ?? "").length > 150 ? "…" : ""}`);
    }
  }
  return lines.join("\n");
}
```

**Step 5: Commit**

```bash
git add lib/bulletin-db.ts index.ts
git commit -m "Implement closedNotify summary notification (issue #4)

Add closedNotify to Bulletin type, return from loadBulletin, remove
raw Discord fetch from bulletin-db.ts, add summary notification via
notify() wrapper on bulletin close."
```

---

### Task 3: Replace `wakeAgentViaGateway` with `bulletin_wake` Gateway method

**This is the core change.** Replaces `sessions_spawn` with CronService-based lightweight agent turns.

**Files:**
- Modify: `index.ts:86-293` (delete spawn-lock + wakeAgentViaGateway), `index.ts:355-365` (register block)

**Step 1: Delete spawn-lock machinery**

Delete lines 86-124 entirely (`LOCKS_DIR`, `LOCK_TTL_MS`, `SpawnLock` interface, `lockPath`, `readLock`, `writeLock`).

**Step 2: Delete `wakeAgentViaGateway` function**

Delete lines 209-293 entirely (the `wakeAgentViaGateway` function).

**Step 3: Delete `getGatewayPort` and `getGatewayToken`**

Delete lines 52-73 (`getGatewayPort`, `getGatewayToken`). These were only used by `wakeAgentViaGateway`.

**Step 4: Remove `http` import**

Delete line 5:
```typescript
import * as http from "node:http";
```

**Step 5: Register the `bulletin_wake` Gateway method**

Inside the `register(api)` function, after the tool registrations and before the hooks, add:

```typescript
    // ── Gateway method: bulletin_wake ────────────────────────────────
    // Creates an immediate one-shot cron job with lightContext for each agent.
    // Replaces sessions_spawn — no subagent_announce, no spawn locks.

    api.registerGatewayMethod("bulletin_wake", async ({ params, context, respond }) => {
      const agentId = params.agentId as string;
      const task = params.task as string;
      const label = params.label as string;

      if (!agentId || !task || !label) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "agentId, task, and label are required" });
        return;
      }

      const jobName = `bulletin-${label}`;

      // Idempotency: skip if a job with this name already exists and hasn't run
      try {
        const existing = await context.cron.list();
        const duplicate = existing.find(j => j.name === jobName && j.enabled);
        if (duplicate) {
          console.log(`[bulletin-tools] Skipping wake for '${agentId}' — job '${jobName}' already exists`);
          respond(true, { status: "skipped", jobId: duplicate.id, reason: "duplicate" });
          return;
        }
      } catch { /* list failed, proceed anyway */ }

      try {
        const job = await context.cron.add({
          name: jobName,
          agentId,
          enabled: true,
          deleteAfterRun: true,
          schedule: { kind: "at", at: new Date().toISOString() },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: {
            kind: "agentTurn",
            message: task,
            lightContext: true,
            thinking: "low",
            timeoutSeconds: 60,
          },
          delivery: { mode: "none" },
        });

        // Force immediate execution — don't wait for cron tick
        await context.cron.run(job.id, "force");

        auditLog(`WAKE agent=${agentId} label=${label} jobId=${job.id}`);
        console.log(`[bulletin-tools] Woke '${agentId}' via cron job: ${jobName}`);
        respond(true, { status: "ok", jobId: job.id });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[bulletin-tools] bulletin_wake failed for '${agentId}': ${msg}`);
        respond(false, undefined, { code: "WAKE_FAILED", message: msg });
      }
    });
```

**Step 6: Add internal `wakeBulletinSubscriber` helper**

Add after the Gateway method registration, before the hooks:

```typescript
    // ── Internal wake helper ─────────────────────────────────────────
    // Calls the bulletin_wake Gateway method via HTTP.

    async function wakeBulletinSubscriber(
      agentId: string,
      bulletins: Array<{ id: string; topic: string; body: string; responses: any[]; resolvedSubscribers: string[] }>,
      label: string,
    ): Promise<boolean> {
      const gatewayToken = (() => {
        try {
          const cfgPath = join(homedir(), ".openclaw", "mailroom", "bulletin-config.json");
          const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
          return resolveConfigToken(cfg.gatewayToken) ?? process.env.GATEWAY_AUTH_TOKEN;
        } catch {
          return process.env.GATEWAY_AUTH_TOKEN;
        }
      })();

      if (!gatewayToken) {
        console.error("[bulletin-tools] No GATEWAY_AUTH_TOKEN — cannot wake agent");
        return false;
      }

      const task = buildBulletinTaskPrompt(bulletins);
      const bulletinIds = bulletins.map(b => b.id);
      const jobLabel = `${bulletinIds.join("-")}-${agentId}-${label}`;

      const payload = JSON.stringify({
        method: "bulletin_wake",
        params: { agentId, task, label: jobLabel },
      });

      return new Promise((resolve) => {
        const port = (() => {
          const envPort = process.env.OPENCLAW_GATEWAY_PORT;
          if (envPort) return parseInt(envPort, 10) || 18789;
          try {
            const cfg = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf-8"));
            return cfg.gateway?.port ?? 18789;
          } catch { return 18789; }
        })();

        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/rpc",
          method: "POST",
          headers: {
            Authorization: `Bearer ${gatewayToken}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
            if (ok) {
              auditLog(`WAKE agent=${agentId} bulletins=${bulletinIds.join(",")} label=${label}`);
              console.log(`[bulletin-tools] Woke '${agentId}': ${bulletinIds.join(", ")}`);
            } else {
              console.error(`[bulletin-tools] Wake failed for '${agentId}': ${res.statusCode} ${body}`);
            }
            resolve(ok);
          });
        });
        req.on("error", (e) => {
          console.error(`[bulletin-tools] Wake error for '${agentId}': ${e.message}`);
          resolve(false);
        });
        req.write(payload);
        req.end();
      });
    }
```

**Note:** Keep the `http` import — `wakeBulletinSubscriber` still uses it to call the Gateway. The difference is it calls `/rpc` with method `bulletin_wake` instead of `/tools/invoke` with `sessions_spawn`.

**Step 7: Update all `wakeAgentViaGateway` call sites**

Replace all calls to `wakeAgentViaGateway` with `wakeBulletinSubscriber`:

- Line 569: `await wakeAgentViaGateway(subId, [latestBulletin], "critique-round")` → `await wakeBulletinSubscriber(subId, [latestBulletin], "critique-round")`
- Line 976: `await wakeAgentViaGateway(agentId, urgent, "urgent")` → `await wakeBulletinSubscriber(agentId, urgent, "urgent")`
- Line 1003: `await wakeAgentViaGateway(agentId, normal, "normal")` → `await wakeBulletinSubscriber(agentId, normal, "normal")`

**Step 8: Commit**

```bash
git add index.ts
git commit -m "Replace sessions_spawn with CronService-based lightweight wakes (issues #1, #3)

Register bulletin_wake Gateway method that creates immediate one-shot
cron jobs with lightContext: true. Eliminates spawn locks, subagent
announcements, and race conditions. Uses cron.run(id, 'force') for
immediate execution."
```

---

### Task 4: Simplify lifecycle hooks and delete suppression logic

**Files:**
- Modify: `index.ts:954-1034`

**Step 1: Delete `pendingAcks` Map**

Delete line 957:
```typescript
const pendingAcks = new Map<string, number>();
```

**Step 2: Simplify `before_agent_start` hook**

Replace lines 959-986 with a passive notice:

```typescript
    api.on("before_agent_start", async (_event, ctx) => {
      const agentId = ctx.agentId;
      if (!agentId) return;
      if (ctx.sessionKey?.includes(":bulletin:")) return;

      try {
        const pending = getUnrespondedBulletins(agentId);
        if (pending.length > 0) {
          console.log(
            `[bulletin-tools] ${agentId} has ${pending.length} unresponded bulletin(s)`,
          );
        }
      } catch (err) {
        console.error(
          "[bulletin-tools] before_agent_start hook error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
```

**Step 3: Simplify `agent_end` hook**

Replace lines 988-1010 with a passive log:

```typescript
    api.on("agent_end", async (_event, ctx) => {
      const agentId = ctx.agentId;
      if (!agentId) return;
      if (ctx.sessionKey?.includes(":bulletin:")) return;

      try {
        const pending = getUnrespondedBulletins(agentId);
        if (pending.length > 0) {
          console.log(
            `[bulletin-tools] agent_end: ${agentId} still has ${pending.length} unresponded bulletin(s)`,
          );
        }
      } catch (err) {
        console.error(
          "[bulletin-tools] agent_end hook error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });
```

**Step 4: Delete `before_message_write` hook entirely**

Delete lines 1012-1034 (the entire `before_message_write` handler).

**Step 5: Commit**

```bash
git add index.ts
git commit -m "Simplify lifecycle hooks — remove spawn logic and message suppression (issue #2)

Hooks become passive observers. No more spawning from before_agent_start
or agent_end. Delete before_message_write hook entirely — no subagent
completions to suppress."
```

---

### Task 5: Update `bulletin-post` CLI script

**Files:**
- Modify: `~/.openclaw/bin/bulletin-post` (lines 115-153, 393-415)

**Step 1: Replace `wakeAgentViaGateway` function**

Replace the `wakeAgentViaGateway` function (lines 115-153) with a `wakeViaLightCron` function:

```javascript
function wakeViaLightCron(agentId, task, label) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const args = [
      'cron', 'add',
      '--agent', agentId,
      '--at', '+0s',
      '--light-context',
      '--session', 'isolated',
      '--message', task,
      '--delete-after-run',
      '--no-deliver',
      '--name', `bulletin-${label}-${agentId}`,
      '--thinking', 'low',
      '--timeout-seconds', '60',
      '--json',
    ];
    execFile('openclaw', args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
  });
}
```

**Step 2: Update the wake calls**

Replace lines 405-412:
```javascript
for (const agentId of resolvedSubscribers) {
  const result = await wakeViaLightCron(agentId, bulletinTask, id);
  if (result.ok) {
    console.log(`  Woke:        ${agentId}`);
  } else {
    console.log(`  Wake fail:   ${agentId} (${result.error})`);
  }
}
```

**Step 3: Remove old `getGatewayPort` and `getGatewayToken` functions**

Delete lines 93-113 (no longer needed — not calling Gateway HTTP directly).

**Step 4: Remove `http` import**

Delete line 7: `const http = require('node:http');`

**Step 5: Commit**

```bash
git add ~/.openclaw/bin/bulletin-post
git commit -m "Update bulletin-post CLI to use openclaw cron for lightweight wakes

Replace sessions_spawn HTTP calls with openclaw cron add --light-context.
Removes Gateway HTTP code and spawn lock dependencies from CLI script."
```

---

### Task 6: Cleanup and verify

**Files:**
- Verify: `index.ts`, `lib/bulletin-db.ts`, `~/.openclaw/bin/bulletin-post`

**Step 1: Verify no remaining references to deleted code**

Run:
```bash
grep -n "wakeAgentViaGateway\|readLock\|writeLock\|LOCKS_DIR\|LOCK_TTL\|pendingAcks\|sessions_spawn\|/tools/invoke" index.ts lib/bulletin-db.ts
```
Expected: no matches.

**Step 2: Verify no remaining raw Discord calls outside `notify()`**

Run:
```bash
grep -n "postToDiscord\|postToThread" index.ts | grep -v "import\|notify\|from.*discord"
```
Expected: no matches (all calls should be inside `notify()`).

**Step 3: Verify `http` import status**

Check if `http` is still needed (it is — `wakeBulletinSubscriber` uses it):
```bash
grep -n "http\." index.ts
```
Expected: only in `wakeBulletinSubscriber`.

**Step 4: Verify TypeScript compiles**

Run:
```bash
cd /home/ubuntu/projects/bulletin-tools && npx tsc --noEmit 2>&1 || true
```
Note: There's no tsconfig, so this may need adjustment. At minimum verify no syntax errors by checking OpenClaw loads the plugin.

**Step 5: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "Cleanup: remove dead references and verify consistency"
```

---

## Execution Notes

**Task dependency order:** Tasks 1 → 2 → 3 → 4 → 5 → 6 (sequential — each builds on prior)

**Risk areas:**
- **Task 3, Step 5:** The `CronJobCreate` type may require fields not shown in the `.d.ts`. If `cron.add()` rejects the payload, check `CronJobBase` required fields (especially `id` which is in the base but excluded from `CronJobCreate` via `Omit`).
- **Task 3, Step 6:** The Gateway RPC endpoint path may be `/rpc` or something else. Check `openclaw gateway --help` or the running gateway logs if the wake call returns 404.
- **Task 5:** The `bulletin-post` script is in `~/.openclaw/bin/`, not in this repo. Changes there won't be tracked by this repo's git. Commit separately or document the change.
