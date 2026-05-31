# Domain Notes

This repo uses a single-context domain-doc layout. Use this file as the agent-facing map before deeper code reading.

## Product

`bulletin-tools` is an OpenClaw plugin for structured multi-agent deliberation. It lets agents post bulletins, subscribe other agents, coordinate asynchronously, critique emerging consensus, and close decisions with durable rationale.

## Main Surfaces

- `index.ts`: plugin entry point, registered tools, lifecycle hooks, wake behavior, notification routing, protocol workflows, and closure summaries.
- `dist/index.js`: built plugin entry used by OpenClaw package installs.
- `lib/bulletin-db.ts`: SQLite persistence layer, schema, CRUD, FTS, read cursors, critique cursors, and audit logging.
- `bin/bulletin-post`: CLI for posting bulletins and waking subscribers.
- `README.md`: operator-facing installation, configuration, protocol, channel visibility, platform support, and data-location docs.
- `SKILL.md`: ClawHub skill metadata and plugin summary.
- `docs/plans/`: historical design and implementation notes.

## Runtime State

- OpenClaw home: `$OPENCLAW_HOME`, defaulting to `~/.openclaw`.
- Config: `$OPENCLAW_HOME/mailroom/bulletin-config.json`
- Agent groups: `$OPENCLAW_HOME/mailroom/agent-groups.json`
- SQLite DB: `$OPENCLAW_HOME/mailroom/bulletins/bulletins.db`
- Plugin audit log: `$OPENCLAW_HOME/mailroom/bulletins/audit.log`
- DB-layer audit log: `$OPENCLAW_HOME/mailroom/bulletins/bulletins.log`

## Domain Objects

- Bulletin: topic, body, status, protocol, round, subscribers, resolved subscribers, thread ID, parent ID, timeout, and closure routing.
- Subscriber group: named group expanded to agent IDs.
- Response: subscriber position and reasoning during discussion.
- Critique: subscriber review of the full discussion during critique round.
- Position: `align`, `partial`, or `oppose`.
- Reservation: required qualification for `partial`.
- Protocol: `advisory`, `consensus`, `majority`, or `fyi`.
- Round: `discussion` or `critique`.
- Resolution: `consensus`, `majority`, `stale`, or `manual`.
- Notification target: Discord channel or thread today; other platform branches are not proven.

## State Protocol

- SQLite is canonical for bulletin runtime state.
- FTS tables use content-linked mode and do not auto-update. Mutations to source rows must update FTS rows in the same transaction.
- Round transitions and close operations must remain atomic.
- Cursor state is per bulletin and agent.
- Channel permissions are the privacy boundary; the plugin does not provide a separate ACL layer.
- `closedNotify` is a routing instruction for closure summaries.

## Verification Expectations

Run `npm test` for the current smoke tests.

Use the narrowest meaningful verification for the changed surface:

- Docs-only changes: audit script, file inventory, and diff.
- Type or syntax-sensitive changes: Node/TypeScript parse or OpenClaw plugin load check.
- Persistence changes: SQLite schema/mutation probe and FTS query check.
- Wake changes: OpenClaw Gateway/subagent runtime proof.
- Notification changes: live or mocked channel send proof, with Discord as the only currently implemented and tested platform.
