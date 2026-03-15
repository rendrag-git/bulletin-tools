import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as http from "node:http";
import { postToDiscord, postToThread } from "./lib/discord-notify.ts";
import {
  getDb,
  getUnrespondedBulletins,
  loadBulletin,
  addResponse,
  saveBulletin,
  closeBulletin as dbCloseBulletin,
  transitionToRound,
  getResponseCount,
  getSubscriberCount,
  renderBulletinsForAgent,
  listBulletins,
  searchBulletins,
} from "./lib/bulletin-db.ts";

// ── Gateway helpers ──────────────────────────────────────────────────────────

let _secrets: Record<string, string> | null = null;

function loadSecrets(): Record<string, string> {
  if (_secrets) return _secrets;
  try {
    _secrets = JSON.parse(
      readFileSync(join(homedir(), ".openclaw", "secrets.json"), "utf-8"),
    ) as Record<string, string>;
  } catch {
    _secrets = {};
  }
  return _secrets;
}

/**
 * Resolve a bot token from bulletin-config.json.
 * Handles literal tokens and ${ENV_VAR} references (via process.env + secrets.json).
 */
function resolveConfigToken(rawToken: string | undefined): string | undefined {
  if (!rawToken) return undefined;
  const match = rawToken.match(/^\$\{([^}]+)\}$/);
  if (match) {
    const varName = match[1];
    return process.env[varName] ?? loadSecrets()[varName];
  }
  return rawToken;
}


const BULLETINS_DIR = join(homedir(), ".openclaw", "mailroom", "bulletins");
const AUDIT_LOG_PATH = join(BULLETINS_DIR, "audit.log");

function auditLog(entry: string): void {
  if (!existsSync(BULLETINS_DIR)) {
    mkdirSync(BULLETINS_DIR, { recursive: true });
  }
  const ts = new Date().toISOString();
  appendFileSync(AUDIT_LOG_PATH, `[${ts}] ${entry}\n`, "utf-8");
}

// ── Notification choke point ─────────────────────────────────────────────
// TODO: Replace with OpenClaw message tool when available (issue #5)

interface NotifyConfig {
  botToken: string;
  escalationChannel?: string;
  dissentThreshold?: number;
}

function loadNotifyConfig(): NotifyConfig | null {
  try {
    const cfgPath = join(homedir(), ".openclaw", "mailroom", "bulletin-config.json");
    if (!existsSync(cfgPath)) return null;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    const botToken = resolveConfigToken(cfg.botToken) ?? process.env.RELAY_BOT_TOKEN;
    if (!botToken) return null;
    return {
      botToken,
      escalationChannel: cfg.escalationChannel,
      dissentThreshold: cfg.dissentThreshold ?? 2,
    };
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


function buildBulletinTaskPrompt(bulletins: Array<{ id: string; topic: string; body: string; responses: any[]; resolvedSubscribers: string[] }>): string {
  const sections: string[] = [
    `You have ${bulletins.length} pending bulletin(s) requiring your response.`,
    `For each bulletin below, call the \`bulletin_respond\` tool with your assessment.`,
    `Do nothing else — respond to all bulletins and stop.`,
    "",
  ];

  for (const b of bulletins) {
    sections.push(`---`);
    sections.push(`## [${b.id}] ${b.topic}`);
    sections.push(``);
    sections.push(b.body);
    sections.push(``);
    // ── Critique round prompt ──────────────────────────────────────────
    if ((b as any).round === "critique") {
      sections.push(`### All Discussion Responses`);
      for (const r of b.responses) {
        const pos = (r as any).position ?? "align";
        const posTag = pos === "oppose" ? " ⚠️ **[OPPOSE]**"
                     : pos === "partial" ? ` ~ **[PARTIAL — ${((r as any).reservations ?? "").slice(0, 60)}]**`
                     : "";
        sections.push(`- **${r.agentId}**${posTag}: ${((r as any).body ?? "").slice(0, 300)}`);
      }
      sections.push(``);
      sections.push(`### Critique Round`);
      sections.push(``);
      sections.push(`All subscribers have responded. Your task now is to critique the discussion — not re-answer the original question.`);
      sections.push(``);
      sections.push(`Before submitting, consider:`);
      sections.push(`- Is the emerging consensus well-founded, or does it reflect momentum?`);
      sections.push(`- What assumption do all responses share that might be wrong?`);
      sections.push(`- What risk or perspective is absent from the entire discussion?`);
      sections.push(`- Which response, if any, do you most disagree with — and why?`);
      const priorCritiques = (b as any).critiques ?? [];
      if (priorCritiques.length >= 2 && priorCritiques.every((c: any) => (c.position ?? "align") === "align")) {
        sections.push(`- ⚠️ Critique responses are also converging — look harder before agreeing with the discussion.`);
      }
      sections.push(``);
      sections.push(`Use \`bulletin_critique\` to submit.`);
      sections.push(`- \`position: "align"\` — the discussion reached the right conclusion`);
      sections.push(`- \`position: "partial"\` — mostly right, but reservations field required`);
      sections.push(`- \`position: "oppose"\` — the discussion reached the wrong conclusion`);
      sections.push(``);
      continue; // skip the discussion-round prompt below
    }
    // ── Discussion round prompt ────────────────────────────────────────
    if (b.responses.length > 0) {
      sections.push(`### Prior Responses`);
      for (const r of b.responses) {
        const pos = (r as any).position ?? "align";
        const posTag = pos === "oppose" ? " ⚠️ **[OPPOSE]**"
                     : pos === "partial" ? ` ~ **[PARTIAL — ${((r as any).reservations ?? "").slice(0, 60)}]**`
                     : "";
        sections.push(`- **${r.agentId}**${posTag}: ${((r as any).body ?? "").slice(0, 300)}`);
      }
      sections.push(``);
      sections.push(`### Your Turn`);
      sections.push(``);
      sections.push(`You've seen the prior responses above. Before responding:`);
      sections.push(`- Do you agree with the emerging direction? If so, add specifics or caveats.`);
      sections.push(`- Do you disagree with any response? Set \`position: "oppose"\` and explain why. Or set \`position: "partial"\` if you agree but have reservations.`);
      sections.push(`- Is there a perspective or risk nobody has raised yet?`);
      if (b.responses.length >= 2 && b.responses.every((r: any) => (r.position ?? "align") === "align")) {
        sections.push(`- Prior responses are converging — look harder for what they're missing before agreeing.`);
      }
      sections.push(``);
      sections.push(`Use \`bulletin_respond\` to reply. Be substantive — "I agree" without reasoning is not useful.`);
    } else {
      sections.push(`*No responses yet — you're the first to respond.*`);
      sections.push(``);
      sections.push(`### Your Turn`);
      sections.push(``);
      sections.push(`Set the direction for this discussion.`);
      sections.push(`Consider trade-offs, risks, and alternatives — not just your recommendation.`);
      sections.push(`Use \`bulletin_respond\` to reply.`);
    }
    sections.push(``);
  }

  return sections.join("\n");
}


// ── bulletin_list helpers ───────────────────────────────────────────────────

function formatBulletinForAgent(
  b: ReturnType<typeof loadBulletin>,
  agentId: string,
): Record<string, unknown> {
  if (!b) return {};
  return {
    id: b.id,
    topic: b.topic,
    body: b.body,
    status: b.status,
    protocol: b.protocol,
    round: b.round,
    urgent: b.urgent,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    closedAt: b.closedAt,
    resolution: b.resolution,
    subscribers: b.resolvedSubscribers,
    responseCount: b.responses?.length ?? 0,
    responses: (b.responses ?? []).map((r) => ({
      agentId: r.agentId,
      position: r.position ?? "align",
      body: r.body?.slice(0, 500),
      reservations: r.reservations,
      timestamp: r.timestamp,
    })),
    critiques: (b.critiques ?? []).map((c) => ({
      agentId: c.agentId,
      position: c.position ?? "align",
      body: c.body?.slice(0, 500),
      reservations: c.reservations,
    })),
    yourStatus: (b.responses ?? []).some((r) => r.agentId === agentId)
      ? "responded"
      : "pending",
  };
}

function formatBulletinSummary(
  b: ReturnType<typeof loadBulletin>,
): Record<string, unknown> {
  if (!b) return {};
  return {
    id: b.id,
    topic: b.topic,
    status: b.status,
    protocol: b.protocol,
    round: b.round,
    urgent: b.urgent,
    createdBy: b.createdBy,
    createdAt: b.createdAt,
    closedAt: b.closedAt,
    resolution: b.resolution,
    responseCount: b.responses?.length ?? 0,
    subscribers: b.resolvedSubscribers,
  };
}

const bulletinToolsPlugin = {
  id: "bulletin-tools",
  name: "Bulletin Board Tools",
  description: "Provides bulletin_respond tool for agents to respond to bulletins",
  kind: "tools",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const agentId =
          ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";

        return {
          name: "bulletin_respond",
          label: "Respond to Bulletin",
          description:
            "Respond to a bulletin on the bulletin board. Use this when you receive a bulletin notification and want to provide your input, acknowledge, or dissent.",
          parameters: {
            type: "object" as const,
            required: ["bulletinId", "response"],
            additionalProperties: false,
            properties: {
              bulletinId: {
                type: "string" as const,
                description: "The bulletin ID to respond to",
              },
              response: {
                type: "string" as const,
                description: "Your response text",
              },
              position: {
                type: "string" as const,
                enum: ["align", "partial", "oppose"],
                description:
                  'Your position: "align" (agree), "partial" (agree with reservations — reservations field required), "oppose" (disagree). Defaults to "align".',
              },
              reservations: {
                type: "string" as const,
                description:
                  'Required when position is "partial". Explain what would change your position to "align".',
              },
            },
          },

          async execute(
            _toolCallId: string,
            params: {
              bulletinId: string;
              response: string;
              position?: "align" | "partial" | "oppose";
              reservations?: string;
            },
          ) {
            const { bulletinId, response, position = "align", reservations } = params;

            // Load bulletin from SQLite
            const bulletin = loadBulletin(bulletinId);
            if (!bulletin) {
              return {
                status: "error",
                message: `Bulletin ${bulletinId} not found.`,
              };
            }

            // Validate status
            if (bulletin.status !== "open") {
              return {
                status: "error",
                message: `Bulletin ${bulletinId} is ${bulletin.status}, not open. Cannot respond.`,
              };
            }

            // Validate agent is a subscriber
            const subscribers = bulletin.resolvedSubscribers ?? [];
            if (!subscribers.includes(agentId)) {
              return {
                status: "error",
                message: `Agent "${agentId}" is not a subscriber of bulletin ${bulletinId}. Subscribers: ${subscribers.join(", ")}`,
              };
            }

            // Check for duplicate response in current round
            const currentRound = bulletin.round ?? "discussion";
            const existingResponses = bulletin.responses ?? [];
            const alreadyResponded = existingResponses.some(
              (r) => r.agentId === agentId,
            );
            if (alreadyResponded) {
              return {
                status: "error",
                message: `Agent "${agentId}" has already responded to bulletin ${bulletinId}.`,
              };
            }

            // Validate partial requires reservations
            if (position === "partial" && !reservations) {
              return {
                status: "error",
                message: 'position "partial" requires a reservations field explaining what would change your position to "align".',
              };
            }

            // Record response in SQLite (handles cursor update)
            const updated = addResponse(bulletinId, agentId, response, position, reservations);
            if (!updated) {
              return {
                status: "error",
                message: `Failed to record response for bulletin ${bulletinId}.`,
              };
            }

            // ── Post response to #bulletin-board thread (best-effort) ────────
            const threadId: string | undefined = updated.threadId;
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

            // Note: manifest.json no longer exists — SQL handles indexing.

            // Audit log
            auditLog(
              `RESPOND bulletin=${bulletinId} agent=${agentId} position=${position} responses=${updated.responses.length}/${subscribers.length}`,
            );

            // ── Completion detection ─────────────────────────────────────
            // Use atomic counts to avoid Race #3 (stale reload)
            const protocol = updated.protocol ?? "advisory";
            const responseCount = getResponseCount(bulletinId, "discussion");
            const subscriberCount = getSubscriberCount(bulletinId);
            const allResponded = responseCount === subscriberCount;

            // ── Majority check (can close before all respond) ────────────
            if (protocol === "majority") {
              const alignCount = updated.responses.filter(
                (r: any) => (r.position ?? "align") === "align",
              ).length;
              if (alignCount / subscribers.length > 0.5) {
                // Atomic close — only winner gets non-null result
                const closed = dbCloseBulletin(bulletinId, "majority");
                if (closed) {
                  auditLog(`MAJORITY_CLOSE bulletin=${bulletinId} align=${alignCount}/${subscribers.length}`);
                  const ncfg = loadNotifyConfig();
                  const msg = `✅ [${bulletinId}] "${updated.topic ?? bulletinId}" — majority (${alignCount}/${subscribers.length} aligned)`;
                  await notify({ channel: ncfg?.escalationChannel }, msg);
                  await notify({ threadId }, `🏁 **Resolved** — ${msg}`);
                  if (closed.closedNotify) {
                    const notifyTarget = closed.closedNotify.replace("channel:", "");
                    await notify({ channel: notifyTarget }, buildCloseSummary(closed));
                  }
                }
              }
            }

            // ── Critique round transition ────────────────────────────────
            if (allResponded && ["advisory", "consensus"].includes(protocol)) {
              // Atomic transition — only the winner gets true
              const won = transitionToRound(bulletinId, "discussion", "critique");
              if (won) {
                auditLog(`CRITIQUE_START bulletin=${bulletinId} protocol=${protocol}`);

                // ── Post critique-round notice to thread + re-notify subscribers ─
                try {
                  await notify(
                    { threadId },
                    `🔄 **Critique round open** — all ${subscribers.length} subscribers responded.\nEach subscriber should now review the discussion and submit a critique using \`bulletin_critique\`.`,
                  );
                  // Notify subscribers via their Discord channels
                  for (const subId of subscribers) {
                    const latestBulletin = loadBulletin(bulletinId);
                    const alreadyCritiqued = (latestBulletin?.critiques ?? []).some(
                      (c: any) => c.agentId === subId,
                    );
                    if (!alreadyCritiqued && latestBulletin) {
                      await wakeBulletinSubscriber(subId, [latestBulletin], "critique-round");
                    }
                  }
                } catch { /* best effort */ }
              }
            }

            // ── Dissent escalation ──────────────────────────────
            if (position === "oppose") {
              try {
                const ncfg = loadNotifyConfig();
                if (ncfg) {
                  const dissenters = new Map<string, string>();
                  for (const r of updated.responses) {
                    if ((r as any).position === "oppose" && !dissenters.has(r.agentId)) {
                      dissenters.set(r.agentId, ((r as any).body ?? "").slice(0, 100));
                    }
                  }
                  if (dissenters.size >= (ncfg.dissentThreshold ?? 2)) {
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
                    await notify({ channel: ncfg.escalationChannel, threadId }, alertText);
                    auditLog(`ESCALATE bulletin=${bulletinId} opposes=${dissenters.size} threshold=${ncfg.dissentThreshold ?? 2}`);
                  }
                }
              } catch (err) {
                console.error("[bulletin-tools] dissent escalation error:", err instanceof Error ? err.message : String(err));
              }
            }

            return {
              status: "ok",
              message: `Response recorded for bulletin ${bulletinId}. (${updated.responses.length}/${subscribers.length} responses)`,
              bulletinId,
              responseCount: updated.responses.length,
              subscriberCount: subscribers.length,
              position,
            };
          },
        };
      },
      { names: ["bulletin_respond"] },
    );

    api.registerTool(
      (ctx) => {
        const agentId =
          ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";

        return {
          name: "bulletin_critique",
          label: "Critique Bulletin Discussion",
          description:
            "Submit your critique after all subscribers have responded. Use this tool ONLY when the bulletin is in critique round — the prompt will tell you. Evaluates whether the discussion reached a sound conclusion.",
          parameters: {
            type: "object" as const,
            required: ["bulletinId", "response"],
            additionalProperties: false,
            properties: {
              bulletinId: {
                type: "string" as const,
                description: "The bulletin ID to critique",
              },
              response: {
                type: "string" as const,
                description: "Your critique of the discussion",
              },
              position: {
                type: "string" as const,
                enum: ["align", "partial", "oppose"],
                description:
                  '"align" = discussion reached right conclusion; "partial" = mostly right but reservations field required; "oppose" = wrong conclusion.',
              },
              reservations: {
                type: "string" as const,
                description: 'Required when position is "partial". What would change your position to "align".',
              },
            },
          },

          async execute(
            _toolCallId: string,
            params: {
              bulletinId: string;
              response: string;
              position?: "align" | "partial" | "oppose";
              reservations?: string;
            },
          ) {
            const { bulletinId, response, position = "align", reservations } = params;

            // Load bulletin from SQLite
            const bulletin = loadBulletin(bulletinId);
            if (!bulletin) {
              return { status: "error", message: `Bulletin ${bulletinId} not found.` };
            }
            if (bulletin.status !== "open") {
              return { status: "error", message: `Bulletin ${bulletinId} is ${bulletin.status}, cannot critique.` };
            }
            if ((bulletin.round ?? "discussion") !== "critique") {
              return { status: "error", message: `Bulletin ${bulletinId} is in discussion round, not critique round. Use bulletin_respond instead.` };
            }
            if (position === "partial" && !reservations) {
              return { status: "error", message: 'position "partial" requires a reservations field.' };
            }

            const alreadyCritiqued = (bulletin.critiques ?? []).some((c: any) => c.agentId === agentId);
            if (alreadyCritiqued) {
              return { status: "error", message: `Agent "${agentId}" has already submitted a critique for ${bulletinId}.` };
            }

            // Record critique via addResponse (uses current round='critique' from DB)
            const updated = addResponse(bulletinId, agentId, response, position, reservations);
            if (!updated) {
              return { status: "error", message: `Failed to record critique for bulletin ${bulletinId}.` };
            }

            const subscribers = updated.resolvedSubscribers ?? [];
            auditLog(`CRITIQUE bulletin=${bulletinId} agent=${agentId} position=${position} critiques=${(updated.critiques ?? []).length}/${subscribers.length}`);

            // ── Post critique to #bulletin-board thread (best-effort) ─────────
            const critiqueThreadId: string | undefined = updated.threadId;
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

            // ── Auto-close check ────────────────────────────────────────────
            // Use atomic counts to avoid Race #3 (stale reload)
            const critiqueCount = getResponseCount(bulletinId, "critique");
            const critSubCount = getSubscriberCount(bulletinId);
            const allCritiqued = critiqueCount === critSubCount;
            if (allCritiqued && updated.protocol === "consensus") {
              const critiques = updated.critiques ?? [];
              const opposeCount = critiques.filter((c: any) => (c.position ?? "align") === "oppose").length;
              const partialCount = critiques.filter((c: any) => (c.position ?? "align") === "partial").length;
              const partialThreshold = (() => {
                try {
                  const cfg = JSON.parse(readFileSync(
                    join(homedir(), ".openclaw", "mailroom", "bulletin-config.json"), "utf-8"
                  ));
                  return cfg.consensusPartialThreshold ?? 0.3;
                } catch { return 0.3; }
              })();
              const genuineConsensus = opposeCount === 0 &&
                (critiques.length === 0 || partialCount / critiques.length < partialThreshold);

              if (genuineConsensus) {
                // Atomic close — only winner gets non-null result
                const closed = dbCloseBulletin(bulletinId, "consensus");
                if (closed) {
                  auditLog(`CONSENSUS_CLOSE bulletin=${bulletinId}`);
                  const ncfg = loadNotifyConfig();
                  await notify(
                    { channel: ncfg?.escalationChannel },
                    `✅ [${bulletinId}] "${updated.topic ?? bulletinId}" — consensus reached`,
                  );
                  await notify(
                    { threadId: critiqueThreadId },
                    `🏁 **Resolved** — consensus reached after critique round.`,
                  );
                  if (closed.closedNotify) {
                    const notifyTarget = closed.closedNotify.replace("channel:", "");
                    await notify({ channel: notifyTarget }, buildCloseSummary(closed));
                  }
                }
              } else {
                auditLog(`CONSENSUS_FAIL bulletin=${bulletinId} opposes=${opposeCount} partials=${partialCount}`);
                const ncfg = loadNotifyConfig();
                const failMsg = [
                  `⚠️ [${bulletinId}] "${updated.topic ?? bulletinId}" — consensus not reached.`,
                  `Critique complete: ${opposeCount} oppose(s), ${partialCount} partial(s).`,
                  `Review required before closing.`,
                ].join("\n");
                await notify({ channel: ncfg?.escalationChannel }, failMsg);
                await notify(
                  { threadId: critiqueThreadId },
                  `⚠️ **Consensus not reached** — ${opposeCount} oppose(s), ${partialCount} partial(s). Human review required.`,
                );
              }
            }

            return {
              status: "ok",
              message: `Critique recorded for bulletin ${bulletinId}. (${(updated.critiques ?? []).length}/${subscribers.length} critiques)`,
              bulletinId,
              critiqueCount: (updated.critiques ?? []).length,
              subscriberCount: subscribers.length,
              position,
            };
          },
        };
      },
      { names: ["bulletin_critique"] },
    );

    // ── bulletin_list tool ──────────────────────────────────────────

    api.registerTool(
      (ctx) => {
        const agentId =
          ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";

        return {
          name: "bulletin_list",
          label: "List Pending Bulletins",
          description:
            "List your pending bulletins with full content, or query bulletin history. " +
            "Call this when your context tells you there are pending bulletins. " +
            "With no params, returns your unresponded open bulletins. " +
            "Supports status filter (open/closed/all), FTS search, and single-bulletin lookup.",
          parameters: {
            type: "object" as const,
            additionalProperties: false,
            properties: {
              bulletinId: {
                type: "string" as const,
                description: "Fetch a specific bulletin by ID.",
              },
              status: {
                type: "string" as const,
                enum: ["open", "closed", "all"],
                description:
                  "Filter by status. Omit for default (your unresponded open bulletins).",
              },
              search: {
                type: "string" as const,
                description:
                  "Full-text search across bulletin topics, bodies, and responses.",
              },
              limit: {
                type: "number" as const,
                description: "Max results. Default: 10.",
              },
            },
          },

          async execute(
            _toolCallId: string,
            params: {
              bulletinId?: string;
              status?: "open" | "closed" | "all";
              search?: string;
              limit?: number;
            },
          ) {
            const limit = params.limit ?? 10;

            // Single bulletin by ID
            if (params.bulletinId) {
              const bulletin = loadBulletin(params.bulletinId);
              if (!bulletin) {
                return {
                  status: "error",
                  message: `Bulletin ${params.bulletinId} not found.`,
                };
              }
              return {
                status: "ok",
                count: 1,
                bulletins: [formatBulletinForAgent(bulletin, agentId)],
              };
            }

            // Full-text search
            if (params.search) {
              const results = searchBulletins(params.search, limit);
              return {
                status: "ok",
                count: results.length,
                query: params.search,
                bulletins: results.map((b) => formatBulletinSummary(b)),
              };
            }

            // Status filter — query history
            if (params.status) {
              const results = listBulletins({
                status: params.status,
                agentId,
                limit,
              });
              return {
                status: "ok",
                count: results.length,
                filter: params.status,
                bulletins: results.map((b) => formatBulletinSummary(b)),
              };
            }

            // Default: unresponded open bulletins — render as full markdown
            const rendered = renderBulletinsForAgent(agentId);
            if (!rendered) {
              return { status: "ok", message: "No pending bulletins.", count: 0 };
            }

            return {
              status: "ok",
              count: getUnrespondedBulletins(agentId).length,
              content: rendered,
            };
          },
        };
      },
      { names: ["bulletin_list"] },
    );

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
        const duplicate = existing.find((j: any) => j.name === jobName && j.enabled);
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
          schedule: { kind: "at" as const, at: new Date().toISOString() },
          sessionTarget: "isolated" as const,
          wakeMode: "now" as const,
          payload: {
            kind: "agentTurn" as const,
            message: task,
            lightContext: true,
            thinking: "low",
            timeoutSeconds: 60,
          },
          delivery: { mode: "none" as const },
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

      const gatewayPort = (() => {
        const envPort = process.env.OPENCLAW_GATEWAY_PORT;
        if (envPort) return parseInt(envPort, 10) || 18789;
        try {
          const cfg = JSON.parse(readFileSync(join(homedir(), ".openclaw", "openclaw.json"), "utf-8"));
          return cfg.gateway?.port ?? 18789;
        } catch { return 18789; }
      })();

      const payload = JSON.stringify({
        method: "bulletin_wake",
        params: { agentId, task, label: jobLabel },
      });

      return new Promise((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: gatewayPort,
          path: "/rpc",
          method: "POST",
          headers: {
            Authorization: `Bearer ${gatewayToken}`,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        }, (res) => {
          let body = "";
          res.on("data", (c: string) => (body += c));
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
        req.on("error", (e: Error) => {
          console.error(`[bulletin-tools] Wake error for '${agentId}': ${e.message}`);
          resolve(false);
        });
        req.write(payload);
        req.end();
      });
    }

    // ── Bulletin auto-response hooks ────────────────────────────────

    // Track pending acknowledgments (agentId → bulletin count)
    const pendingAcks = new Map<string, number>();

    api.on("before_agent_start", async (_event, ctx) => {
      const agentId = ctx.agentId;
      if (!agentId) return;

      if (ctx.sessionKey?.includes(":bulletin:")) return;
      // Don't spawn bulletin sessions from the main DM session — avoids
      // bulletin status chatter in the user's DMs
      if (ctx.sessionKey === "agent:main:main") return;

      try {
        const urgent = getUnrespondedBulletins(agentId, { urgent: true });
        if (urgent.length === 0) return;

        console.log(
          `[bulletin-tools] before_agent_start: ${agentId} has ${urgent.length} unresponded urgent bulletin(s)`,
        );

        const notified = await wakeBulletinSubscriber(agentId, urgent, "urgent");
        if (notified) {
          pendingAcks.set(agentId, urgent.length);
        }
      } catch (err) {
        console.error(
          "[bulletin-tools] before_agent_start hook error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });

    api.on("agent_end", async (_event, ctx) => {
      const agentId = ctx.agentId;
      if (!agentId) return;

      if (ctx.sessionKey?.includes(":bulletin:")) return;
      if (ctx.sessionKey === "agent:main:main") return;

      try {
        const normal = getUnrespondedBulletins(agentId, { urgent: false });
        if (normal.length === 0) return;

        console.log(
          `[bulletin-tools] agent_end: ${agentId} has ${normal.length} unresponded normal bulletin(s)`,
        );

        await wakeBulletinSubscriber(agentId, normal, "normal");
      } catch (err) {
        console.error(
          "[bulletin-tools] agent_end hook error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    });

    api.on("before_message_write", (event, ctx) => {
      const agentId = ctx.agentId;
      if (!agentId) return;

      const count = pendingAcks.get(agentId);
      if (!count) return;

      const msg = event.message as any;
      if (msg?.role !== "assistant") return;

      if (typeof msg.content === "string") {
        msg.content += `\n\n---\n📋 Responding to ${count} pending bulletin(s) in the background.`;
      } else if (Array.isArray(msg.content)) {
        const lastText = [...msg.content].reverse().find((c: any) => c.type === "text");
        if (lastText) {
          lastText.text += `\n\n---\n📋 Responding to ${count} pending bulletin(s) in the background.`;
        }
      }

      pendingAcks.delete(agentId);

      return { message: msg };
    });

    // ── Timeout scheduler for bulletins with timeout_minutes ─────────

    function scheduleTimeouts() {
      try {
        const db = getDb();
        const openWithTimeout = db.prepare(
          `SELECT id, created_at, timeout_minutes FROM bulletins WHERE status = 'open' AND timeout_minutes IS NOT NULL`
        ).all() as Array<{ id: string; created_at: string; timeout_minutes: number }>;

        for (const row of openWithTimeout) {
          const created = new Date(row.created_at).getTime();
          const deadline = created + (row.timeout_minutes * 60 * 1000);
          const remaining = deadline - Date.now();

          if (remaining <= 0) {
            const closed = dbCloseBulletin(row.id, "stale", `Timed out after ${row.timeout_minutes} minutes`);
            if (closed?.closedNotify) {
              const notifyTarget = closed.closedNotify.replace("channel:", "");
              void notify({ channel: notifyTarget }, buildCloseSummary(closed));
            }
          } else {
            setTimeout(() => {
              const current = loadBulletin(row.id);
              if (current && current.status === "open") {
                const closed = dbCloseBulletin(row.id, "stale", `Timed out after ${row.timeout_minutes} minutes`);
                if (closed?.closedNotify) {
                  const notifyTarget = closed.closedNotify.replace("channel:", "");
                  void notify({ channel: notifyTarget }, buildCloseSummary(closed));
                }
              }
            }, remaining);
          }
        }
      } catch (err) {
        // DB not ready yet or no bulletins, ignore
      }
    }

    // Run on startup after a short delay (let DB init first)
    setTimeout(scheduleTimeouts, 5000);
  },
};

export default bulletinToolsPlugin;
