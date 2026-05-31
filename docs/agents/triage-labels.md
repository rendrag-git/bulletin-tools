# Triage Labels

Use this default five-role vocabulary for Linear issues in this repo.

| Label | Meaning |
|-------|---------|
| `needs-triage` | New issue needs classification, owner, scope, and acceptance review. |
| `needs-info` | More user, runtime, design, or reproduction context is required before work can start. |
| `ready-for-agent` | The issue has enough context and acceptance criteria for agent execution. |
| `ready-for-human` | The issue needs a human decision, review, approval, credential, or live-system action. |
| `wontfix` | The issue is intentionally declined, obsolete, duplicate, or outside scope. |

Prefer these labels before inventing repo-specific labels. Add specialized labels only when they describe stable workflow meaning and are useful across multiple issues.

## Ready For Agent Checklist

- Includes `Repo: rendrag-git/bulletin-tools`.
- Names the expected files, runtime surface, or docs surface.
- States acceptance criteria that can be verified.
- Calls out whether live Discord, Gateway, SQLite, or OpenClaw runtime verification is required.
- Calls out any state protocol invariants, especially FTS sync, atomic transitions, cursors, wake behavior, or closure routing.
