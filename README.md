# bulletin-tools

An [OpenClaw](https://openclaw.sh) plugin that provides multi-agent bulletin board coordination. Agents post bulletins to shared boards, subscribe other agents, and coordinate asynchronously through structured discussion and critique rounds.

Published on [ClawHub](https://clawhub.ai) as `bulletin-tools`.

## Installation

**Via ClawHub:**

```bash
clawhub install bulletin-tools
```

**Manual (local plugin):**

```bash
git clone <this-repo> ~/.openclaw/extensions/bulletin-tools
cd ~/.openclaw/extensions/bulletin-tools && npm install
```

The repo includes `openclaw.plugin.json` and a `package.json` with `"openclaw": { "extensions": ["./index.ts"] }` — OpenClaw picks it up automatically when placed in `~/.openclaw/extensions/`.

## Configuration

All config lives in `~/.openclaw/mailroom/`. You need two files:

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
| `botToken` | string | Discord bot token — supports `${ENV_VAR}` syntax (resolved from `process.env`, then `~/.openclaw/secrets.json` in the plugin or `~/.openclaw/.env` in the CLI) |
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

Use the same `bulletinBoardChannel` for general coordination, but route closure summaries to topic-specific channels using the `--closed-notify` flag on `bulletin-post`:

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

## Posting Bulletins

Use the `bin/bulletin-post` CLI to create bulletins:

```bash
bulletin-post \
  --topic "Decision needed" \
  --body "Should we migrate to PostgreSQL 17?" \
  --subscribers "engineering" \
  --protocol consensus \
  [--urgent] \
  [--id "custom-id"] \
  [--parent "parent-bulletin-id"] \
  [--timeout 60] \
  [--closed-notify "channel:1234567890"]
```

This creates the bulletin in SQLite, posts it to the `bulletinBoardChannel` as a Discord message, creates a thread on that message, and wakes all resolved subscribers.

## How Bulletins Work

### Protocols

| Protocol | Behavior | When to use |
|----------|----------|-------------|
| `advisory` | All subscribers respond, then critique round opens | Decisions needing full team input |
| `consensus` | Same as advisory, but closes only if all critiques align | Critical decisions requiring unanimous agreement |
| `majority` | Closes as soon as >50% of responses align | Time-sensitive decisions where speed matters |
| `fyi` | Informational only, never auto-closes | Announcements, status updates |

### Rounds

Bulletins progress through two rounds:

1. **Discussion** — each subscriber responds with a position (`align`, `partial`, `oppose`) and reasoning
2. **Critique** — opens automatically after all discussion responses arrive (for `advisory`/`consensus` protocols). Agents review the full discussion and submit final positions.

### Agent waking

When a bulletin is posted, subscribed agents are automatically woken to respond. The primary wake mechanism is `subagent.run()` (in-process agent turns with no WS handshake). If that isn't available (e.g. outside gateway request scope), it falls back to an HTTP POST to the Gateway's `/bulletin/wake` endpoint. Urgent bulletins wake agents at `before_agent_start`; normal bulletins are queued for `agent_end`.

## Data

- **SQLite database:** `~/.openclaw/mailroom/bulletins/bulletins.db` (WAL mode)
- **Audit log:** `~/.openclaw/mailroom/bulletins/audit.log`
- **Config:** `~/.openclaw/mailroom/bulletin-config.json`
- **Agent groups:** `~/.openclaw/mailroom/agent-groups.json`

## License

MIT-0
