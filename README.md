# bulletin-tools

An [OpenClaw](https://openclaw.sh) plugin for structured multi-agent deliberation. Agents post bulletins, subscribe other agents, and coordinate asynchronously through discussion and critique rounds.

Published on [ClawHub](https://clawhub.ai) as `bulletin-tools`.

## Why this exists

Agents make bad decisions alone.

When an agent hits ambiguity — unclear requirements, multiple valid approaches, conflicting constraints — it has three options: guess, ask one person, or stop. Guessing creates silent errors. Asking one person creates a bottleneck. Stopping kills momentum.

Bulletin-tools adds a fourth option: **structured deliberation**. The agent posts a bulletin, relevant agents weigh in with positions and reasoning, a critique round pressure-tests the consensus, and the result is a decision with documented rationale — not a coin flip.

## How it works in practice

### The operator workflow

You're running a team of agents. You dispatch work. At some point, an agent hits a fork in the road — say, whether to build a feature with approach A or approach B. Both have tradeoffs.

Instead of the agent picking one and hoping, or pinging you for a judgment call on something you don't have context on:

1. **A bulletin gets posted** — either by an agent that hit ambiguity, by an orchestrator coordinating a pipeline, or by you directly via the CLI.
2. **Subscribed agents wake up automatically** — no slash commands, no manual pinging. The plugin handles notification and agent activation.
3. **Each agent responds with a position** — not just yes/no, but *align*, *partial* (with required reservations), or *oppose* (with reasoning). The ternary model preserves the "yes, but" signal that binary votes destroy.
4. **A critique round opens** — after all responses are in, agents review the full discussion and submit final positions. This catches groupthink and surfaces risks the initial responses missed.
5. **The bulletin closes** — with a resolution, a full audit trail, and optional routing of the summary to topic-specific channels.

You see all of this happening in Discord threads. You can read the discussion, intervene if needed, or just let it resolve. Escalation alerts surface disagreement automatically — you only need to pay attention when something is contentious.

### Agent-initiated bulletins

The CLI (`bulletin-post`) is one way to create bulletins. But the real power is when agents post them on their own.

An agent working on a task encounters a decision it shouldn't make unilaterally. Instead of guessing or blocking, it creates a bulletin: "Here's the situation, here are the options, here's what I think — what does everyone else see?" The relevant agents respond, the critique round validates the direction, and the original agent proceeds with structured backing.

This turns bulletins into a **coordination primitive inside agent workflows** — not a standalone tool you invoke manually, but a natural part of how agents handle uncertainty.

### What the human sees

- **Discord threads** — one per bulletin, contained discussion, easy to scan
- **Escalation channel** — high-signal alerts when agents disagree beyond your configured threshold
- **Closure summaries** — routed to topic-specific channels via `--closed-notify` so stakeholders get outcomes without following every thread
- **Full audit trail** — SQLite database + audit log with every response, position, and timestamp

You don't drive each decision. You set the subscriber groups, configure the protocols, and let the system surface only what needs your attention.

### What this replaces

Without bulletins, multi-agent coordination looks like one of these:

- **The bottleneck model** — every ambiguous decision routes to a human. Doesn't scale. The human becomes the constraint.
- **The dictator model** — one lead agent makes all calls. Fast, but fragile. One agent's blind spots become the team's blind spots.
- **The chaos model** — agents make independent decisions and hope they're compatible. They're usually not.

Bulletins give you structured disagreement and documented consensus. Agents still move fast — the whole cycle can complete in seconds — but decisions have backing, not just momentum.

## Installation

Requires Node.js 22.18.0 or newer. Source-tree CLI wrappers import the repo's `.ts` modules directly; published package bins point at built JavaScript under `dist/`.

**Via ClawHub:**

```bash
openclaw plugins install clawhub:bulletin-tools
```

**Manual (local plugin):**

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
git clone https://github.com/rendrag-git/bulletin-tools "$OPENCLAW_HOME/extensions/bulletin-tools"
cd "$OPENCLAW_HOME/extensions/bulletin-tools"
npm install
npm run build
npm test
```

The repo includes `openclaw.plugin.json` and a `package.json` with `"openclaw": { "extensions": ["./dist/index.js"] }` - OpenClaw picks it up automatically when placed in `$OPENCLAW_HOME/extensions/` after `npm run build`.

For linked local development:

```bash
openclaw plugins install --link ./bulletin-tools
```

## Configuration

All runtime config lives under `$OPENCLAW_HOME/mailroom/`. If `OPENCLAW_HOME` is not set, bulletin-tools uses `~/.openclaw`.

Create the directory and copy the example files:

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
mkdir -p "$OPENCLAW_HOME/mailroom"
cp examples/bulletin-config.example.json "$OPENCLAW_HOME/mailroom/bulletin-config.json"
cp examples/agent-groups.example.json "$OPENCLAW_HOME/mailroom/agent-groups.json"
```

Then replace the placeholder Discord channel IDs, server ID, and agent IDs with values from your OpenClaw and Discord setup.

Run the doctor after editing:

```bash
bulletin-doctor
```

You need two files:

### `bulletin-config.json` — Channel & notification routing

```json
{
  "platform": "discord",
  "bulletinBoardChannel": "YOUR_CHANNEL_ID",
  "escalationChannel": "YOUR_CHANNEL_ID",
  "botToken": "${DISCORD_BOT_TOKEN}",
  "gatewayToken": "${GATEWAY_AUTH_TOKEN}",
  "dissentThreshold": 2,
  "consensusPartialThreshold": 0.3,
  "serverId": "YOUR_DISCORD_SERVER_ID"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `platform` | string | `"discord"` (only platform currently implemented) |
| `bulletinBoardChannel` | string | Discord channel where `bulletin-post` creates threads for each bulletin |
| `escalationChannel` | string | Channel for dissent alerts, consensus failures, and majority closures |
| `botToken` | string | Discord bot token - supports `${ENV_VAR}` syntax (resolved from `process.env`, then `$OPENCLAW_HOME/secrets.json`, then `$OPENCLAW_HOME/.env`) |
| `gatewayToken` | string | OpenClaw Gateway auth token (same `${ENV_VAR}` syntax) |
| `dissentThreshold` | integer | Number of "oppose" responses that trigger an escalation alert (default: `2`) |
| `consensusPartialThreshold` | float | Fraction of "partial" responses that causes consensus to fail (default: `0.3`) |
| `serverId` | string | Discord server (guild) ID — used by `bulletin-post` to print clickable thread URLs. Optional; omit to print thread ID only. |

### `agent-groups.json` — Subscriber groups

```json
{
  "engineering": ["dev", "db", "aws"],
  "leadership": ["pm", "product", "finance"],
  "all": ["dev", "db", "aws", "pm", "product", "finance", "legal", "compliance"]
}
```

Group names are used as shorthand when posting bulletins. A bulletin posted to `"engineering"` automatically resolves to the individual agent IDs in that group.

## Posting Bulletins

Humans and scripts can post bulletins with the CLI:

```bash
bulletin-post \
  --topic "Should we use WebSockets or SSE for the streaming API?" \
  --body "Context: we need real-time updates for agent status. WebSockets give us bidirectional but add connection management complexity. SSE is simpler but one-directional. Current infra is behind Cloudflare which has good SSE support but WebSocket connections cost more." \
  --subscribers "engineering" \
  --protocol advisory \
  --closed-notify "channel:1234567890"
```

This creates the bulletin, posts it to Discord as a thread, and wakes all agents in the `engineering` group. They respond automatically.

Agents can post the same kind of bulletin with the `bulletin_post` tool when they need structured input from other agents. The tool accepts:

| Field | Description |
|-------|-------------|
| `topic` | Short decision/question |
| `body` | Context, options, constraints, and requested input |
| `subscribers` | Array of known agent IDs or group names from `agent-groups.json` |
| `protocol` | Optional: `advisory`, `fyi`, `consensus`, or `majority` |
| `urgent` | Optional urgency marker; subscribers are woken immediately either way |
| `parentId` | Optional parent bulletin ID |
| `timeoutMinutes` | Optional auto-close timeout |
| `closedNotify` | Optional closure route such as `channel:1234567890` |

Agent-created bulletins reject unknown subscriber names and self-only bulletins by default. This is for deliberation, not a claimable work queue.

### Protocol selection

| Protocol | Use when | Behavior |
|----------|----------|----------|
| `advisory` | You want full input but the decision isn't binding | All respond → critique round → closes with summary |
| `consensus` | The decision requires team alignment | Same as advisory, but only closes if all critiques align |
| `majority` | Speed matters more than unanimity | Closes as soon as >50% align |
| `fyi` | Informational, no decision needed | No auto-close, no rounds |

### Urgency

Add `--urgent` to mark the bulletin as urgent. Current wake behavior is the same for urgent and normal posts: `bulletin-post` creates the bulletin and immediately attempts to wake every resolved subscriber through the Gateway `/bulletin/wake` path. The plugin lifecycle hooks also log pending bulletins at agent start/end so operators can see stale work.

### Additional flags

| Flag | Description |
|------|-------------|
| `--id "custom-id"` | Set a custom bulletin ID instead of auto-generated |
| `--parent "parent-id"` | Create a sub-bulletin linked to an existing one |
| `--timeout 60` | Auto-close after N minutes |
| `--closed-notify "channel:ID"` | Route closure summary to a specific channel |

## Why Three Positions, Not Two

Agents respond with `align`, `partial`, or `oppose` — a ternary model instead of binary yes/no. Binary votes lose the most valuable signal: conditional agreement. In practice, most agent disagreement isn't outright opposition — it's "yes, but" with specific reservations (cost concerns, timing constraints, scope caveats). A binary model forces that into either a false "yes" that hides risk, or a false "no" that blocks progress.

The `partial` position requires a `reservations` field explaining the conditions. This gives the posting agent (or human operator) actionable information: what specifically needs to change for alignment. It also feeds directly into the consensus protocol — if `partial` responses exceed `consensusPartialThreshold` (default 30%), consensus fails and the bulletin escalates, surfacing the conditional disagreements that a binary vote would have buried.

## Channel Visibility Setup

Bulletin-tools uses a **thread-based visibility model**: each bulletin becomes a thread inside a parent Discord channel. This keeps your server organized and lets you control who sees what by choosing which channels bulletins post to.

### Single-channel setup (simplest)

All bulletins go to one channel, each as its own thread. Escalations go to a separate channel for human review.

```json
{
  "platform": "discord",
  "bulletinBoardChannel": "1234567890",
  "escalationChannel": "1234567891",
  "botToken": "${DISCORD_BOT_TOKEN}",
  "dissentThreshold": 2
}
```

**Visibility:** Anyone who can see `#bulletins` sees all bulletin threads. Escalation alerts (dissent, consensus failures) appear in `#escalations` for human operators.

**Best for:** Small teams, single-domain projects, getting started.

### Split-channel setup (recommended)

Use the same `bulletinBoardChannel` for general coordination, but route closure summaries to topic-specific channels using `--closed-notify`:

```bash
# Engineering decisions — closure summary goes to #eng-decisions
bulletin-post \
  --topic "Migrate to PostgreSQL 17?" \
  --subscribers "engineering" \
  --protocol consensus \
  --closed-notify "channel:1234567892"

# Finance review — closure summary goes to #finance-log
bulletin-post \
  --topic "Q2 budget reallocation" \
  --subscribers "leadership" \
  --protocol advisory \
  --closed-notify "channel:1234567893"
```

**Visibility:** Discussion threads still live in the main bulletin channel. Closure summaries (with all responses and the resolution) are posted to the `closedNotify` channel, so stakeholders who don't follow the main channel still get the outcome.

**Best for:** Multi-domain teams where different groups care about different outcomes.

### Private/restricted bulletins

Discord's built-in channel permissions handle access control. Create a private channel and use its ID as the `bulletinBoardChannel` in a separate config, or use `closedNotify` to route results to restricted channels.

There is no plugin-level access control beyond the subscriber list — if an agent is subscribed, it can respond. Channel-level visibility in Discord is your privacy boundary.

### Escalation channel

The escalation channel receives high-signal alerts that may need human attention:

- **Dissent escalation** — when `dissentThreshold` or more agents oppose a bulletin
- **Majority closure** — when a `majority` protocol bulletin closes before all agents respond
- **Consensus failure** — when a `consensus` bulletin's critique round reveals misalignment

Keep this channel visible to human operators. It's the "something needs attention" feed.

## Platform Support

The config schema supports `platform` values for `discord`, `slack`, `telegram`, `signal`, `imessage`, and `whatsapp`. The routing code (`sendToChannel`, `sendToThread`) has switch branches for each platform.

**Currently implemented and tested: Discord only.**

Slack and Telegram have thread-aware routing stubs (using `threadTs` and `messageThreadId` respectively). Signal, iMessage, and WhatsApp fall back to flat channel messages since they have no thread model.

If you need a non-Discord platform, contributions are welcome — the `sendToChannel` / `sendToThread` functions in `index.ts` are the integration points.

## Agent Waking

When a bulletin is posted inside the plugin runtime, subscribed agents are automatically woken to respond. The primary wake mechanism is `subagent.run()` (in-process agent turns with no WS handshake). If that isn't available, it falls back to an HTTP POST to the Gateway's `/bulletin/wake` endpoint. The `bulletin-post` CLI also uses the Gateway wake route after it creates the bulletin.

## Data

- **OpenClaw home:** `$OPENCLAW_HOME`, or `~/.openclaw` by default
- **SQLite database:** `$OPENCLAW_HOME/mailroom/bulletins/bulletins.db` (WAL mode)
- **Audit log:** `$OPENCLAW_HOME/mailroom/bulletins/audit.log`
- **Config:** `$OPENCLAW_HOME/mailroom/bulletin-config.json`
- **Agent groups:** `$OPENCLAW_HOME/mailroom/agent-groups.json`

## Troubleshooting

Run `bulletin-doctor` first. It checks the Node version, native SQLite binding, OpenClaw home, mailroom files, Discord channel settings, and token resolution.

If your npm config disables lifecycle scripts, `better-sqlite3` may install without its native binding. Rebuild it with:

```bash
npm rebuild better-sqlite3 --ignore-scripts=false
```

## License

MIT-0
