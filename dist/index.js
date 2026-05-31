import { readFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import * as http from "node:http";
import { loadBulletinConfig, resolveConfigToken, } from "./lib/config.js";
import { getBulletinAuditLogPath, getBulletinConfigPath, getBulletinDbPath, getBulletinsDir, getOpenClawConfigPath, } from "./lib/paths.js";
import { getDb, getUnrespondedBulletins, loadBulletin, addResponse, createBulletin, closeBulletin as dbCloseBulletin, transitionToRound, getResponseCount, getSubscriberCount, renderBulletinsForAgent, listBulletins, searchBulletins, } from "./lib/bulletin-db.js";
import { resolveBulletinSubscribers, } from "./lib/subscribers.js";
// ── Module-level API handle (set in register()) ───────────────────────────────
let _api = null;
const BULLETINS_DIR = getBulletinsDir();
const AUDIT_LOG_PATH = getBulletinAuditLogPath();
function auditLog(entry) {
    if (!existsSync(BULLETINS_DIR)) {
        mkdirSync(BULLETINS_DIR, { recursive: true });
    }
    const ts = new Date().toISOString();
    appendFileSync(AUDIT_LOG_PATH, `[${ts}] ${entry}\n`, "utf-8");
}
function loadNotifyConfig() {
    try {
        const cfgPath = getBulletinConfigPath();
        if (!existsSync(cfgPath))
            return null;
        const cfg = loadBulletinConfig();
        if (!cfg)
            return null;
        const platform = cfg.platform ?? "discord";
        if (platform !== "discord") {
            console.warn(`[bulletin-tools] unsupported notification platform: ${platform}`);
            return null;
        }
        const botToken = resolveConfigToken(cfg.botToken) ?? process.env.RELAY_BOT_TOKEN;
        if (!botToken)
            return null;
        return {
            platform,
            botToken,
            accountId: cfg.accountId,
            bulletinBoardChannel: cfg.bulletinBoardChannel,
            escalationChannel: cfg.escalationChannel,
            dissentThreshold: cfg.dissentThreshold ?? 2,
        };
    }
    catch {
        return null;
    }
}
async function sendToChannel(platform, channel, text, cfg) {
    if (!_api)
        return;
    const ch = _api.runtime.channel;
    const opts = { token: cfg.botToken, accountId: cfg.accountId };
    switch (platform) {
        case "discord":
            await ch.discord.sendMessageDiscord(`channel:${channel}`, text, opts);
            break;
    }
}
async function sendToThread(platform, threadId, channel, text, cfg) {
    if (!_api)
        return;
    const ch = _api.runtime.channel;
    const opts = { token: cfg.botToken, accountId: cfg.accountId };
    switch (platform) {
        case "discord":
            await ch.discord.sendMessageDiscord(`channel:${threadId}`, text, opts);
            break;
    }
}
async function notify(target, message) {
    if (!_api)
        return;
    const cfg = loadNotifyConfig();
    if (!cfg)
        return;
    const platform = cfg.platform;
    try {
        if (target.channel) {
            await sendToChannel(platform, target.channel, message, cfg);
        }
        if (target.threadId) {
            await sendToThread(platform, target.threadId, target.channel, message, cfg);
        }
    }
    catch { /* best effort — never block bulletin operations */ }
}
function buildCloseSummary(bulletin) {
    if (!bulletin)
        return "";
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
function buildBulletinTaskPrompt(bulletins) {
    const sections = [
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
        if (b.round === "critique") {
            sections.push(`### All Discussion Responses`);
            for (const r of b.responses) {
                const pos = r.position ?? "align";
                const posTag = pos === "oppose" ? " ⚠️ **[OPPOSE]**"
                    : pos === "partial" ? ` ~ **[PARTIAL — ${(r.reservations ?? "").slice(0, 60)}]**`
                        : "";
                sections.push(`- **${r.agentId}**${posTag}: ${(r.body ?? "").slice(0, 300)}`);
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
            const priorCritiques = b.critiques ?? [];
            if (priorCritiques.length >= 2 && priorCritiques.every((c) => (c.position ?? "align") === "align")) {
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
                const pos = r.position ?? "align";
                const posTag = pos === "oppose" ? " ⚠️ **[OPPOSE]**"
                    : pos === "partial" ? ` ~ **[PARTIAL — ${(r.reservations ?? "").slice(0, 60)}]**`
                        : "";
                sections.push(`- **${r.agentId}**${posTag}: ${(r.body ?? "").slice(0, 300)}`);
            }
            sections.push(``);
            sections.push(`### Your Turn`);
            sections.push(``);
            sections.push(`You've seen the prior responses above. Before responding:`);
            sections.push(`- Do you agree with the emerging direction? If so, add specifics or caveats.`);
            sections.push(`- Do you disagree with any response? Set \`position: "oppose"\` and explain why. Or set \`position: "partial"\` if you agree but have reservations.`);
            sections.push(`- Is there a perspective or risk nobody has raised yet?`);
            if (b.responses.length >= 2 && b.responses.every((r) => (r.position ?? "align") === "align")) {
                sections.push(`- Prior responses are converging — look harder for what they're missing before agreeing.`);
            }
            sections.push(``);
            sections.push(`Use \`bulletin_respond\` to reply. Be substantive — "I agree" without reasoning is not useful.`);
        }
        else {
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
function formatBulletinForAgent(b, agentId) {
    if (!b)
        return {};
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
function formatBulletinSummary(b) {
    if (!b)
        return {};
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
function canAgentReadBulletin(bulletin, agentId) {
    if (!bulletin || !agentId || agentId === "unknown")
        return false;
    return bulletin.createdBy === agentId || bulletin.resolvedSubscribers.includes(agentId);
}
const VALID_PROTOCOLS = ["advisory", "fyi", "consensus", "majority"];
function isBulletinProtocol(value) {
    return VALID_PROTOCOLS.includes(value);
}
function normalizeSubscriberInput(value) {
    if (Array.isArray(value)) {
        return value
            .filter((entry) => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean);
    }
    if (typeof value === "string") {
        return value.split(",").map((entry) => entry.trim()).filter(Boolean);
    }
    return [];
}
function normalizeBulletinId(value) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80)
        return null;
    return /^[a-zA-Z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}
function generatedBulletinId(agentId) {
    const safeAgentId = agentId.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 40) || "agent";
    return normalizeBulletinId(`blt-${safeAgentId}-${Date.now()}`) ?? `blt-${Date.now()}`;
}
const bulletinToolsPlugin = {
    id: "bulletin-tools",
    name: "Bulletin Board Tools",
    description: "Provides bulletin tools for agents to post, respond to, and review bulletins",
    kind: "tools",
    configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
    },
    register(api) {
        _api = api;
        api.registerTool((ctx) => {
            const agentId = ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";
            return {
                name: "bulletin_post",
                label: "Post Bulletin",
                description: "Create a structured decision/input bulletin for other subscribed agents. Use this for multi-agent deliberation, not for posting claimable work items.",
                parameters: {
                    type: "object",
                    required: ["topic", "body", "subscribers"],
                    additionalProperties: false,
                    properties: {
                        id: {
                            type: "string",
                            description: "Optional stable bulletin ID. Allowed characters: letters, numbers, dot, underscore, colon, and dash.",
                        },
                        topic: {
                            type: "string",
                            description: "Short decision or question the agents should evaluate.",
                        },
                        body: {
                            type: "string",
                            description: "Context, options, constraints, and the input requested from subscribers.",
                        },
                        subscribers: {
                            type: "array",
                            items: { type: "string" },
                            description: "Known agent IDs or group names from agent-groups.json.",
                        },
                        protocol: {
                            type: "string",
                            enum: VALID_PROTOCOLS,
                            description: "advisory, fyi, consensus, or majority. Defaults to advisory.",
                        },
                        urgent: {
                            type: "boolean",
                            description: "Marks the bulletin urgent. Subscribers are woken immediately either way.",
                        },
                        parentId: {
                            type: "string",
                            description: "Optional parent bulletin ID for follow-up bulletins.",
                        },
                        timeoutMinutes: {
                            type: "number",
                            description: "Optional auto-close timeout in minutes.",
                        },
                        closedNotify: {
                            type: "string",
                            description: "Optional closure route, for example channel:1234567890.",
                        },
                        allowSelfOnly: {
                            type: "boolean",
                            description: "Allow creating a bulletin where the posting agent is the only subscriber. Defaults to false.",
                        },
                    },
                },
                async execute(_toolCallId, params) {
                    const topic = typeof params.topic === "string" ? params.topic.trim() : "";
                    const body = typeof params.body === "string" ? params.body.trim() : "";
                    if (!topic || topic.length > 200) {
                        return {
                            status: "error",
                            message: "topic is required and must be 200 characters or fewer.",
                        };
                    }
                    if (!body || body.length > 8000) {
                        return {
                            status: "error",
                            message: "body is required and must be 8000 characters or fewer.",
                        };
                    }
                    const requestedSubscribers = normalizeSubscriberInput(params.subscribers);
                    if (requestedSubscribers.length === 0 || requestedSubscribers.length > 50) {
                        return {
                            status: "error",
                            message: "subscribers must contain between 1 and 50 known group or agent IDs.",
                        };
                    }
                    const protocol = params.protocol ?? "advisory";
                    if (!isBulletinProtocol(protocol)) {
                        return {
                            status: "error",
                            message: `Invalid protocol "${protocol}". Must be one of: ${VALID_PROTOCOLS.join(", ")}.`,
                        };
                    }
                    const resolution = resolveBulletinSubscribers(requestedSubscribers, { allowUnknown: false });
                    if (resolution.unknown.length > 0) {
                        return {
                            status: "error",
                            message: `Unknown subscriber group or agent ID: ${resolution.unknown.join(", ")}`,
                            knownGroups: Object.keys(resolution.groups),
                            knownAgents: resolution.knownAgents,
                        };
                    }
                    if (resolution.resolved.length === 0) {
                        return {
                            status: "error",
                            message: "No subscribers resolved. Check agent-groups.json and openclaw.json.",
                        };
                    }
                    if (params.allowSelfOnly !== true &&
                        resolution.resolved.length === 1 &&
                        resolution.resolved[0] === agentId) {
                        return {
                            status: "error",
                            message: "Refusing to create a self-only bulletin. Add another subscriber or set allowSelfOnly.",
                        };
                    }
                    const parentId = typeof params.parentId === "string" && params.parentId.trim()
                        ? params.parentId.trim()
                        : undefined;
                    if (parentId && !loadBulletin(parentId)) {
                        return {
                            status: "error",
                            message: `Parent bulletin "${parentId}" not found.`,
                        };
                    }
                    const timeoutMinutes = typeof params.timeoutMinutes === "number"
                        ? Math.trunc(params.timeoutMinutes)
                        : undefined;
                    if (timeoutMinutes !== undefined && (timeoutMinutes <= 0 || timeoutMinutes > 10080)) {
                        return {
                            status: "error",
                            message: "timeoutMinutes must be between 1 and 10080.",
                        };
                    }
                    const bulletinId = params.id
                        ? normalizeBulletinId(params.id)
                        : generatedBulletinId(agentId);
                    if (!bulletinId) {
                        return {
                            status: "error",
                            message: "id must be 1-80 characters and contain only letters, numbers, dot, underscore, colon, and dash.",
                        };
                    }
                    const created = createBulletin({
                        id: bulletinId,
                        topic,
                        body,
                        urgent: params.urgent === true,
                        subscribers: resolution.requested,
                        resolvedSubscribers: resolution.resolved,
                        createdBy: agentId,
                        protocol,
                        parentId,
                        closedNotify: typeof params.closedNotify === "string" && params.closedNotify.trim()
                            ? params.closedNotify.trim()
                            : undefined,
                        timeoutMinutes,
                    });
                    if (!created) {
                        return {
                            status: "error",
                            message: `Failed to create bulletin ${bulletinId}. It may already exist.`,
                        };
                    }
                    auditLog(`CREATE bulletin=${bulletinId} agent=${agentId} subscribers=${resolution.resolved.join(",")} protocol=${protocol}`);
                    const cfg = loadNotifyConfig();
                    if (cfg?.bulletinBoardChannel) {
                        await notify({ channel: cfg.bulletinBoardChannel }, [
                            `📋 **[${bulletinId}] ${topic}**`,
                            `*Created by: ${agentId} | Protocol: ${protocol} | Subscribers: ${resolution.resolved.join(", ")}*`,
                            "",
                            body.slice(0, 1800),
                            body.length > 1800 ? "\n…" : "",
                        ].join("\n"));
                    }
                    for (const subId of resolution.resolved) {
                        await wakeBulletinSubscriber(subId, [created], "agent-created");
                    }
                    return {
                        status: "ok",
                        message: `Bulletin ${bulletinId} created and ${resolution.resolved.length} subscriber(s) notified.`,
                        bulletinId,
                        protocol,
                        subscribers: resolution.resolved,
                        createdBy: agentId,
                    };
                },
            };
        }, { names: ["bulletin_post"] });
        api.registerTool((ctx) => {
            const agentId = ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";
            return {
                name: "bulletin_respond",
                label: "Respond to Bulletin",
                description: "Respond to a bulletin on the bulletin board. Use this when you receive a bulletin notification and want to provide your input, acknowledge, or dissent.",
                parameters: {
                    type: "object",
                    required: ["bulletinId", "response"],
                    additionalProperties: false,
                    properties: {
                        bulletinId: {
                            type: "string",
                            description: "The bulletin ID to respond to",
                        },
                        response: {
                            type: "string",
                            description: "Your response text",
                        },
                        position: {
                            type: "string",
                            enum: ["align", "partial", "oppose"],
                            description: 'Your position: "align" (agree), "partial" (agree with reservations — reservations field required), "oppose" (disagree). Defaults to "align".',
                        },
                        reservations: {
                            type: "string",
                            description: 'Required when position is "partial". Explain what would change your position to "align".',
                        },
                    },
                },
                async execute(_toolCallId, params) {
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
                    const alreadyResponded = existingResponses.some((r) => r.agentId === agentId);
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
                    const threadId = updated.threadId;
                    if (threadId) {
                        const posTag = position === "oppose" ? " ⚠️ **[OPPOSE]**"
                            : position === "partial" ? ` ~ **[PARTIAL]**`
                                : " ✅";
                        const snippet = response.slice(0, 280);
                        await notify({ threadId }, `${posTag} **${agentId}** responded:\n> ${snippet}${response.length > 280 ? "…" : ""}`);
                    }
                    // Note: manifest.json no longer exists — SQL handles indexing.
                    // Audit log
                    auditLog(`RESPOND bulletin=${bulletinId} agent=${agentId} position=${position} responses=${updated.responses.length}/${subscribers.length}`);
                    // ── Completion detection ─────────────────────────────────────
                    // Use atomic counts to avoid Race #3 (stale reload)
                    const protocol = updated.protocol ?? "advisory";
                    const responseCount = getResponseCount(bulletinId, "discussion");
                    const subscriberCount = getSubscriberCount(bulletinId);
                    const allResponded = responseCount === subscriberCount;
                    // ── Majority check (can close before all respond) ────────────
                    if (protocol === "majority") {
                        const alignCount = updated.responses.filter((r) => (r.position ?? "align") === "align").length;
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
                                await notify({ threadId }, `🔄 **Critique round open** — all ${subscribers.length} subscribers responded.\nEach subscriber should now review the discussion and submit a critique using \`bulletin_critique\`.`);
                                // Notify subscribers via their Discord channels
                                for (const subId of subscribers) {
                                    const latestBulletin = loadBulletin(bulletinId);
                                    const alreadyCritiqued = (latestBulletin?.critiques ?? []).some((c) => c.agentId === subId);
                                    if (!alreadyCritiqued && latestBulletin) {
                                        await wakeBulletinSubscriber(subId, [latestBulletin], "critique-round");
                                    }
                                }
                            }
                            catch { /* best effort */ }
                        }
                    }
                    // ── Dissent escalation ──────────────────────────────
                    if (position === "oppose") {
                        try {
                            const ncfg = loadNotifyConfig();
                            if (ncfg) {
                                const dissenters = new Map();
                                for (const r of updated.responses) {
                                    if (r.position === "oppose" && !dissenters.has(r.agentId)) {
                                        dissenters.set(r.agentId, (r.body ?? "").slice(0, 100));
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
                                        `Review in SQLite DB: ${getBulletinDbPath()}`,
                                    ].join("\n");
                                    await notify({ channel: ncfg.escalationChannel, threadId }, alertText);
                                    auditLog(`ESCALATE bulletin=${bulletinId} opposes=${dissenters.size} threshold=${ncfg.dissentThreshold ?? 2}`);
                                }
                            }
                        }
                        catch (err) {
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
        }, { names: ["bulletin_respond"] });
        api.registerTool((ctx) => {
            const agentId = ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";
            return {
                name: "bulletin_critique",
                label: "Critique Bulletin Discussion",
                description: "Submit your critique after all subscribers have responded. Use this tool ONLY when the bulletin is in critique round — the prompt will tell you. Evaluates whether the discussion reached a sound conclusion.",
                parameters: {
                    type: "object",
                    required: ["bulletinId", "response"],
                    additionalProperties: false,
                    properties: {
                        bulletinId: {
                            type: "string",
                            description: "The bulletin ID to critique",
                        },
                        response: {
                            type: "string",
                            description: "Your critique of the discussion",
                        },
                        position: {
                            type: "string",
                            enum: ["align", "partial", "oppose"],
                            description: '"align" = discussion reached right conclusion; "partial" = mostly right but reservations field required; "oppose" = wrong conclusion.',
                        },
                        reservations: {
                            type: "string",
                            description: 'Required when position is "partial". What would change your position to "align".',
                        },
                    },
                },
                async execute(_toolCallId, params) {
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
                    const alreadyCritiqued = (bulletin.critiques ?? []).some((c) => c.agentId === agentId);
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
                    const critiqueThreadId = updated.threadId;
                    if (critiqueThreadId) {
                        const posTag = position === "oppose" ? " ⚠️ **[OPPOSE]**"
                            : position === "partial" ? ` ~ **[PARTIAL]**`
                                : " 🧐";
                        const snippet = response.slice(0, 280);
                        await notify({ threadId: critiqueThreadId }, `${posTag} **${agentId}** critique:\n> ${snippet}${response.length > 280 ? "…" : ""}`);
                    }
                    // ── Auto-close check ────────────────────────────────────────────
                    // Use atomic counts to avoid Race #3 (stale reload)
                    const critiqueCount = getResponseCount(bulletinId, "critique");
                    const critSubCount = getSubscriberCount(bulletinId);
                    const allCritiqued = critiqueCount === critSubCount;
                    if (allCritiqued && updated.protocol === "consensus") {
                        const critiques = updated.critiques ?? [];
                        const opposeCount = critiques.filter((c) => (c.position ?? "align") === "oppose").length;
                        const partialCount = critiques.filter((c) => (c.position ?? "align") === "partial").length;
                        const partialThreshold = (() => {
                            try {
                                const cfg = JSON.parse(readFileSync(getBulletinConfigPath(), "utf-8"));
                                return cfg.consensusPartialThreshold ?? 0.3;
                            }
                            catch {
                                return 0.3;
                            }
                        })();
                        const genuineConsensus = opposeCount === 0 &&
                            (critiques.length === 0 || partialCount / critiques.length < partialThreshold);
                        if (genuineConsensus) {
                            // Atomic close — only winner gets non-null result
                            const closed = dbCloseBulletin(bulletinId, "consensus");
                            if (closed) {
                                auditLog(`CONSENSUS_CLOSE bulletin=${bulletinId}`);
                                const ncfg = loadNotifyConfig();
                                await notify({ channel: ncfg?.escalationChannel }, `✅ [${bulletinId}] "${updated.topic ?? bulletinId}" — consensus reached`);
                                await notify({ threadId: critiqueThreadId }, `🏁 **Resolved** — consensus reached after critique round.`);
                                if (closed.closedNotify) {
                                    const notifyTarget = closed.closedNotify.replace("channel:", "");
                                    await notify({ channel: notifyTarget }, buildCloseSummary(closed));
                                }
                            }
                        }
                        else {
                            auditLog(`CONSENSUS_FAIL bulletin=${bulletinId} opposes=${opposeCount} partials=${partialCount}`);
                            const ncfg = loadNotifyConfig();
                            const failMsg = [
                                `⚠️ [${bulletinId}] "${updated.topic ?? bulletinId}" — consensus not reached.`,
                                `Critique complete: ${opposeCount} oppose(s), ${partialCount} partial(s).`,
                                `Review required before closing.`,
                            ].join("\n");
                            await notify({ channel: ncfg?.escalationChannel }, failMsg);
                            await notify({ threadId: critiqueThreadId }, `⚠️ **Consensus not reached** — ${opposeCount} oppose(s), ${partialCount} partial(s). Human review required.`);
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
        }, { names: ["bulletin_critique"] });
        // ── bulletin_list tool ──────────────────────────────────────────
        api.registerTool((ctx) => {
            const agentId = ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1] ?? "unknown";
            return {
                name: "bulletin_list",
                label: "List Pending Bulletins",
                description: "List your pending bulletins with full content, or query bulletin history. " +
                    "Call this when your context tells you there are pending bulletins. " +
                    "With no params, returns your unresponded open bulletins. " +
                    "Supports status filter (open/closed/all), FTS search, and single-bulletin lookup.",
                parameters: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                        bulletinId: {
                            type: "string",
                            description: "Fetch a specific bulletin by ID.",
                        },
                        status: {
                            type: "string",
                            enum: ["open", "closed", "all"],
                            description: "Filter by status. Omit for default (your unresponded open bulletins).",
                        },
                        search: {
                            type: "string",
                            description: "Full-text search across bulletin topics, bodies, and responses.",
                        },
                        limit: {
                            type: "number",
                            description: "Max results. Default: 10.",
                        },
                    },
                },
                async execute(_toolCallId, params) {
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
                        if (!canAgentReadBulletin(bulletin, agentId)) {
                            return {
                                status: "error",
                                message: `Bulletin ${params.bulletinId} is not visible to ${agentId}.`,
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
                        const results = searchBulletins(params.search, limit)
                            .filter((b) => canAgentReadBulletin(b, agentId));
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
        }, { names: ["bulletin_list"] });
        // ── Shared wake logic ──────────────────────────────────────────────
        // Uses api.runtime.subagent.run() to run agent turns in-process.
        // No WS handshake, no cron service needed.
        const subagent = api.runtime.subagent;
        function normalizeWakeBulletinIds(params) {
            const raw = Array.isArray(params?.bulletinIds) ? params.bulletinIds
                : typeof params?.bulletinId === "string" ? [params.bulletinId]
                    : [];
            return raw
                .filter((entry) => typeof entry === "string")
                .map((entry) => entry.trim())
                .filter(Boolean)
                .slice(0, 20);
        }
        async function doBulletinWake(agentId, bulletins, label) {
            if (!agentId || !label || !Array.isArray(bulletins) || bulletins.length === 0) {
                return { ok: false, error: { code: "INVALID_PARAMS", message: "agentId, bulletinIds, and label are required" } };
            }
            const unauthorized = bulletins.find((bulletin) => !bulletin.resolvedSubscribers.includes(agentId));
            if (unauthorized) {
                return {
                    ok: false,
                    error: {
                        code: "FORBIDDEN",
                        message: `Agent ${agentId} is not subscribed to bulletin ${unauthorized.id}`,
                    },
                };
            }
            const task = buildBulletinTaskPrompt(bulletins);
            const sessionKey = `agent:${agentId}:bulletin:${label}`;
            try {
                const result = await subagent.run({
                    sessionKey,
                    message: task,
                    idempotencyKey: `bulletin-wake-${label}-${Date.now()}`,
                });
                auditLog(`WAKE agent=${agentId} label=${label} runId=${result.runId}`);
                console.log(`[bulletin-tools] Woke '${agentId}' via subagent.run: ${sessionKey}`);
                return { ok: true, payload: { status: "ok", runId: result.runId, sessionKey } };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`[bulletin-tools] bulletin_wake failed for '${agentId}': ${msg}`);
                return { ok: false, error: { code: "WAKE_FAILED", message: msg } };
            }
        }
        // ── Gateway method: bulletin_wake (WS) — kept for compatibility ─────
        api.registerGatewayMethod("bulletin_wake", async ({ params, respond }) => {
            const bulletinIds = normalizeWakeBulletinIds(params);
            const bulletins = bulletinIds.map((id) => loadBulletin(id)).filter(Boolean);
            if (bulletins.length !== bulletinIds.length) {
                respond(false, undefined, {
                    code: "NOT_FOUND",
                    message: "One or more bulletinIds were not found",
                });
                return;
            }
            const result = await doBulletinWake(params.agentId, bulletins, params.label);
            if (result.ok) {
                respond(true, result.payload);
            }
            else if ("error" in result) {
                respond(false, undefined, result.error);
            }
        });
        // ── HTTP route: /bulletin/wake ───────────────────────────────────────
        // Primary path for bulletin-post and internal callers.
        api.registerHttpRoute({
            path: "/bulletin/wake",
            auth: "gateway",
            match: "exact",
            handler: async (req, res) => {
                if (req.method !== "POST") {
                    res.statusCode = 405;
                    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
                    return true;
                }
                const body = await new Promise((resolve) => {
                    let data = "";
                    req.on("data", (chunk) => (data += chunk));
                    req.on("end", () => resolve(data));
                });
                let params;
                try {
                    params = JSON.parse(body);
                }
                catch {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
                    return true;
                }
                const bulletinIds = normalizeWakeBulletinIds(params);
                const bulletins = bulletinIds.map((id) => loadBulletin(id)).filter(Boolean);
                if (bulletins.length !== bulletinIds.length) {
                    res.statusCode = 404;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "One or more bulletinIds were not found" } }));
                    return true;
                }
                const result = await doBulletinWake(params.agentId, bulletins, params.label);
                res.statusCode = result.ok ? 200 : 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(result));
                return true;
            },
        });
        // ── Internal wake helper ─────────────────────────────────────────
        // Tries subagent.run directly; falls back to HTTP /bulletin/wake
        // when called outside a gateway request scope (e.g. from tool handlers).
        async function wakeBulletinSubscriber(agentId, bulletins, label) {
            const bulletinIds = bulletins.map(b => b.id);
            const jobLabel = `${bulletinIds.join("-")}-${agentId}-${label}`;
            // Try direct path first
            const result = await doBulletinWake(agentId, bulletins, jobLabel);
            if (result.ok) {
                auditLog(`WAKE agent=${agentId} bulletins=${bulletinIds.join(",")} label=${label}`);
                console.log(`[bulletin-tools] Woke '${agentId}': ${bulletinIds.join(", ")}`);
                return true;
            }
            // If subagent.run failed because we're outside gateway request scope,
            // fall back to HTTP self-call to /bulletin/wake
            if ("error" in result && result.error.message.includes("gateway request")) {
                console.log(`[bulletin-tools] Falling back to HTTP wake for '${agentId}'`);
                return wakeViaHttp(agentId, bulletinIds, jobLabel);
            }
            console.error(`[bulletin-tools] Wake failed for '${agentId}': ${"error" in result ? result.error.message : "unknown error"}`);
            return false;
        }
        // HTTP fallback for waking agents when subagent.run isn't available
        async function wakeViaHttp(agentId, bulletinIds, label) {
            const gatewayToken = (() => {
                try {
                    const cfg = loadBulletinConfig();
                    if (!cfg)
                        return process.env.GATEWAY_AUTH_TOKEN;
                    return resolveConfigToken(cfg.gatewayToken) ?? process.env.GATEWAY_AUTH_TOKEN;
                }
                catch {
                    return process.env.GATEWAY_AUTH_TOKEN;
                }
            })();
            if (!gatewayToken) {
                console.error("[bulletin-tools] No GATEWAY_AUTH_TOKEN — cannot wake agent via HTTP");
                return false;
            }
            const gatewayPort = (() => {
                const envPort = process.env.OPENCLAW_GATEWAY_PORT;
                if (envPort)
                    return parseInt(envPort, 10) || 18789;
                try {
                    const cfg = JSON.parse(readFileSync(getOpenClawConfigPath(), "utf-8"));
                    return cfg.gateway?.port ?? 18789;
                }
                catch {
                    return 18789;
                }
            })();
            const payload = JSON.stringify({ agentId, bulletinIds, label });
            return new Promise((resolve) => {
                const req = http.request({
                    hostname: "127.0.0.1",
                    port: gatewayPort,
                    path: "/bulletin/wake",
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
                        let ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
                        if (ok) {
                            try {
                                ok = JSON.parse(body).ok !== false;
                            }
                            catch { }
                        }
                        if (ok) {
                            console.log(`[bulletin-tools] Woke '${agentId}' via HTTP fallback`);
                        }
                        else {
                            console.error(`[bulletin-tools] HTTP wake failed for '${agentId}': ${res.statusCode} ${body}`);
                        }
                        resolve(ok);
                    });
                });
                req.on("error", (e) => {
                    console.error(`[bulletin-tools] HTTP wake error for '${agentId}': ${e.message}`);
                    resolve(false);
                });
                req.write(payload);
                req.end();
            });
        }
        // ── Bulletin lifecycle hooks (passive — waking happens at post-time) ──
        api.on("before_agent_start", async (_event, ctx) => {
            const agentId = ctx.agentId;
            if (!agentId)
                return;
            if (ctx.sessionKey?.includes(":bulletin:"))
                return;
            try {
                const pending = getUnrespondedBulletins(agentId);
                if (pending.length > 0) {
                    console.log(`[bulletin-tools] ${agentId} has ${pending.length} unresponded bulletin(s)`);
                }
            }
            catch (err) {
                console.error("[bulletin-tools] before_agent_start hook error:", err instanceof Error ? err.message : String(err));
            }
        });
        api.on("agent_end", async (_event, ctx) => {
            const agentId = ctx.agentId;
            if (!agentId)
                return;
            if (ctx.sessionKey?.includes(":bulletin:"))
                return;
            try {
                const pending = getUnrespondedBulletins(agentId);
                if (pending.length > 0) {
                    console.log(`[bulletin-tools] agent_end: ${agentId} still has ${pending.length} unresponded bulletin(s)`);
                }
            }
            catch (err) {
                console.error("[bulletin-tools] agent_end hook error:", err instanceof Error ? err.message : String(err));
            }
        });
        // ── Lightweight bootstrap for bulletin sessions ────────────────────
        // Bulletin wake sessions (agent:*:bulletin:*) don't need full agent
        // context. Strip bootstrapFiles to keep them lightweight.
        api.registerHook("agent:bootstrap", async (event) => {
            if (!event.sessionKey?.includes(":bulletin:"))
                return;
            // Clear all bootstrap files — the task prompt has everything the agent needs
            if (event.context?.bootstrapFiles) {
                // Keep only IDENTITY.md or SOUL.md if present (minimal agent identity)
                event.context.bootstrapFiles = event.context.bootstrapFiles.filter((f) => f.name === "IDENTITY.md" || f.name === "SOUL.md");
            }
            console.log(`[bulletin-tools] Lightweight bootstrap for ${event.sessionKey} (${event.context?.bootstrapFiles?.length ?? 0} files kept)`);
        }, {
            name: "bulletin-tools.lightweight-bootstrap",
            description: "Strips bootstrap files for bulletin wake sessions to reduce context",
        });
        // ── Timeout scheduler for bulletins with timeout_minutes ─────────
        function scheduleTimeouts() {
            try {
                const db = getDb();
                const openWithTimeout = db.prepare(`SELECT id, created_at, timeout_minutes FROM bulletins WHERE status = 'open' AND timeout_minutes IS NOT NULL`).all();
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
                    }
                    else {
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
            }
            catch (err) {
                // DB not ready yet or no bulletins, ignore
            }
        }
        // Run on startup after a short delay (let DB init first)
        setTimeout(scheduleTimeouts, 5000);
    },
};
export default bulletinToolsPlugin;
//# sourceMappingURL=index.js.map