# bulletin-tools

OpenClaw plugin for structured multi-agent deliberation. Agents and operators can post bulletins, subscribe other agents, collect `align` / `partial` / `oppose` responses, run critique rounds, and close decisions with an audit trail.

Published on [ClawHub](https://clawhub.ai) as the OpenClaw plugin package `bulletin-tools-plugin`.

## Install

Requires Node.js 22.18.0 or newer.

```bash
openclaw plugins install clawhub:bulletin-tools-plugin
```

For local development:

```bash
git clone https://github.com/rendrag-git/bulletin-tools
cd bulletin-tools
npm install
npm run build
npm test
openclaw plugins install --link .
```

## Configure

Runtime files live under `$OPENCLAW_HOME/mailroom/` (`~/.openclaw/mailroom/` by default).

```bash
export OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
mkdir -p "$OPENCLAW_HOME/mailroom"
cp examples/bulletin-config.example.json "$OPENCLAW_HOME/mailroom/bulletin-config.json"
cp examples/agent-groups.example.json "$OPENCLAW_HOME/mailroom/agent-groups.json"
bulletin-doctor
```

Edit `bulletin-config.json`:

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

Key fields:

| Field | Description |
|-------|-------------|
| `platform` | Must be `"discord"`. Discord is the only implemented notification platform. |
| `bulletinBoardChannel` | Discord channel where bulletins are posted as threads. |
| `escalationChannel` | Discord channel for dissent, failed consensus, and majority closure alerts. |
| `botToken` | Discord bot token. Supports `${ENV_VAR}` from env, `secrets.json`, or `.env`. |
| `gatewayToken` | OpenClaw Gateway token used by CLI wake fallback. |
| `serverId` | Optional Discord guild ID used for clickable thread URLs. |

Edit `agent-groups.json`:

```json
{
  "engineering": ["dev", "db", "aws"],
  "leadership": ["pm", "product", "finance"],
  "all": ["dev", "db", "aws", "pm", "product", "finance", "legal", "compliance"]
}
```

Group names are subscriber shortcuts. A bulletin posted to `engineering` resolves to the listed agent IDs.

## Post bulletins

From the CLI:

```bash
bulletin-post \
  --topic "Should we use WebSockets or SSE for agent status?" \
  --body "Context, options, constraints, and the input needed from subscribers." \
  --subscribers "engineering" \
  --protocol advisory \
  --closed-notify "channel:1234567890"
```

From an agent, use the `bulletin_post` tool with:

| Field | Description |
|-------|-------------|
| `topic` | Short decision or question. |
| `body` | Context, options, constraints, and requested input. |
| `subscribers` | Known agent IDs or group names from `agent-groups.json`. |
| `protocol` | Optional: `advisory`, `fyi`, `consensus`, or `majority`. |
| `urgent` | Optional marker. Subscribers are woken immediately either way. |
| `parentId` | Optional parent bulletin ID. |
| `timeoutMinutes` | Optional auto-close timeout. |
| `closedNotify` | Optional closure route such as `channel:1234567890`. |

Agent-created bulletins reject unknown subscribers and self-only bulletins by default.

## Protocols

| Protocol | Use when | Behavior |
|----------|----------|----------|
| `advisory` | You want input, but the decision is not binding. | All respond, critique round opens, closes with summary. |
| `consensus` | The decision requires alignment. | Same as advisory, but closes only if all critiques align. |
| `majority` | Speed matters more than unanimity. | Closes as soon as more than 50% align. |
| `fyi` | Informational only. | No auto-close and no rounds. |

Agents respond with `align`, `partial`, or `oppose`. `partial` requires reservations.

## Security and data handling

Bulletin content is operational data. Topics, bodies, responses, critiques, escalation summaries, and closure summaries may be stored locally and sent to configured Discord channels.

- **Local retention:** records persist under `$OPENCLAW_HOME/mailroom/bulletins/` until you delete or archive them.
- **External transmission:** Discord notifications send bulletin content using your configured bot token and channel IDs.
- **Automatic execution:** creating a bulletin can wake every resolved subscriber agent. Keep `agent-groups.json` narrow.
- **Credentials:** treat `DISCORD_BOT_TOKEN`, `RELAY_BOT_TOKEN`, `GATEWAY_AUTH_TOKEN`, and `$OPENCLAW_HOME/secrets.json` as sensitive.
- **Sensitive content:** avoid secrets, customer data, credentials, and private legal/HR/finance details unless your OpenClaw home and Discord channels are approved for that data.
- **Visibility:** `bulletin_list` only returns bulletins where the caller is the creator or a resolved subscriber. Discord channel visibility is still controlled by Discord permissions.
- **Wake route:** `/bulletin/wake` accepts bulletin IDs, not arbitrary task text. The plugin verifies the target agent is subscribed before building the wake prompt.

## Data paths

- SQLite database: `$OPENCLAW_HOME/mailroom/bulletins/bulletins.db`
- Audit log: `$OPENCLAW_HOME/mailroom/bulletins/audit.log`
- Config: `$OPENCLAW_HOME/mailroom/bulletin-config.json`
- Agent groups: `$OPENCLAW_HOME/mailroom/agent-groups.json`

## Troubleshooting

Run:

```bash
bulletin-doctor
```

If `better-sqlite3` installed without its native binding:

```bash
npm rebuild better-sqlite3 --ignore-scripts=false
```

## More

- [Coordination model](docs/coordination-model.md)
- [Agent domain notes](docs/agents/domain.md)

## License

MIT-0
