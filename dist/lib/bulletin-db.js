/**
 * Bulletin SQLite Store
 *
 * Replaces flat JSON bulletin storage with SQLite.
 * Uses better-sqlite3 for synchronous, embedded access.
 *
 * Database location: $OPENCLAW_HOME/mailroom/bulletins/bulletins.db,
 * or ~/.openclaw/mailroom/bulletins/bulletins.db by default.
 *
 * ⚠️ FTS Content-Sync: The FTS tables use content='bulletins' and
 * content='bulletin_responses' — they do NOT auto-update. Every INSERT
 * into bulletins must also INSERT into bulletins_fts. Every INSERT into
 * bulletin_responses must also INSERT into responses_fts. Wrap all
 * data mutations + FTS updates in the same transaction.
 *
 * Note: foreign_keys = ON is set per-connection via pragma. Direct CLI
 * access (sqlite3 CLI) does NOT enforce FKs by default — run
 * `PRAGMA foreign_keys = ON;` manually if you need FK enforcement in
 * the CLI.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, appendFileSync, } from "node:fs";
import { getBulletinDbPath, getBulletinsDir, getDbAuditLogPath, } from "./paths.js";
// ── Constants ───────────────────────────────────────────────────────────────
const BULLETINS_DIR = getBulletinsDir();
const DB_PATH = getBulletinDbPath();
const AUDIT_LOG_PATH = getDbAuditLogPath();
// ── DB Connection ───────────────────────────────────────────────────────────
let _db = null;
export function getDb() {
    if (_db)
        return _db;
    if (!existsSync(BULLETINS_DIR)) {
        mkdirSync(BULLETINS_DIR, { recursive: true });
    }
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    ensureSchema(_db);
    return _db;
}
function ensureSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS bulletins (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      protocol TEXT NOT NULL DEFAULT 'advisory',
      round TEXT NOT NULL DEFAULT 'discussion',
      urgent INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      resolution TEXT,
      thread_id TEXT,
      parent_id TEXT REFERENCES bulletins(id)
    );

    CREATE TABLE IF NOT EXISTS bulletin_subscribers (
      bulletin_id TEXT NOT NULL REFERENCES bulletins(id),
      agent_id TEXT NOT NULL,
      group_name TEXT,
      PRIMARY KEY (bulletin_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS bulletin_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bulletin_id TEXT NOT NULL REFERENCES bulletins(id),
      agent_id TEXT NOT NULL,
      round TEXT NOT NULL DEFAULT 'discussion',
      position TEXT DEFAULT 'align',
      reservations TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(bulletin_id, agent_id, round)
    );

    CREATE TABLE IF NOT EXISTS bulletin_cursors (
      bulletin_id TEXT NOT NULL REFERENCES bulletins(id),
      agent_id TEXT NOT NULL,
      last_seen_response_id INTEGER DEFAULT -1,
      PRIMARY KEY (bulletin_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_bulletins_status ON bulletins(status);
    CREATE INDEX IF NOT EXISTS idx_bulletins_created ON bulletins(created_at);
    CREATE INDEX IF NOT EXISTS idx_subs_agent ON bulletin_subscribers(agent_id);
    CREATE INDEX IF NOT EXISTS idx_responses_bulletin ON bulletin_responses(bulletin_id);
    CREATE INDEX IF NOT EXISTS idx_responses_agent ON bulletin_responses(agent_id);
    CREATE INDEX IF NOT EXISTS idx_responses_bul_agent_round ON bulletin_responses(bulletin_id, agent_id, round);
    CREATE INDEX IF NOT EXISTS idx_bulletins_urgent_status ON bulletins(urgent, status);
    CREATE INDEX IF NOT EXISTS idx_bulletins_parent ON bulletins(parent_id);
  `);
    // FTS tables — CREATE VIRTUAL TABLE doesn't support IF NOT EXISTS
    try {
        db.exec(`
      CREATE VIRTUAL TABLE bulletins_fts USING fts5(
        id UNINDEXED, topic, body,
        content='bulletins', content_rowid='rowid'
      );
    `);
    }
    catch {
        /* table already exists */
    }
    try {
        db.exec(`
      CREATE VIRTUAL TABLE responses_fts USING fts5(
        bulletin_id UNINDEXED, agent_id UNINDEXED, body,
        content='bulletin_responses', content_rowid='id'
      );
    `);
    }
    catch {
        /* table already exists */
    }
    // Migrations for new columns
    try {
        db.exec(`ALTER TABLE bulletins ADD COLUMN closed_notify TEXT`);
    }
    catch { /* already exists */ }
    try {
        db.exec(`ALTER TABLE bulletins ADD COLUMN timeout_minutes INTEGER`);
    }
    catch { /* already exists */ }
}
// ── CRUD ────────────────────────────────────────────────────────────────────
export function createBulletin(opts) {
    const db = getDb();
    const now = new Date().toISOString();
    const insertBulletin = db.prepare(`
    INSERT INTO bulletins (id, topic, body, status, protocol, round, urgent, created_by, created_at, parent_id, closed_notify, timeout_minutes)
    VALUES (?, ?, ?, 'open', ?, 'discussion', ?, ?, ?, ?, ?, ?)
  `);
    const insertSub = db.prepare(`
    INSERT INTO bulletin_subscribers (bulletin_id, agent_id, group_name)
    VALUES (?, ?, ?)
  `);
    const insertCursor = db.prepare(`
    INSERT INTO bulletin_cursors (bulletin_id, agent_id, last_seen_response_id)
    VALUES (?, ?, -1)
  `);
    const insertFts = db.prepare(`
    INSERT INTO bulletins_fts (id, topic, body)
    VALUES (?, ?, ?)
  `);
    const txn = db.transaction(() => {
        insertBulletin.run(opts.id, opts.topic, opts.body, opts.protocol ?? "advisory", opts.urgent ? 1 : 0, opts.createdBy, now, opts.parentId ?? null, opts.closedNotify ?? null, opts.timeoutMinutes ?? null);
        for (const agentId of opts.resolvedSubscribers) {
            // Store original group name if the subscriber list differs from resolved
            // Use the first non-matching entry as a group hint (best-effort)
            const groupName = opts.subscribers.length !== opts.resolvedSubscribers.length
                ? (opts.subscribers.find((s) => !opts.resolvedSubscribers.includes(s)) ?? null)
                : null;
            insertSub.run(opts.id, agentId, groupName);
            insertCursor.run(opts.id, agentId);
        }
        // FTS content-sync: manual insert required
        insertFts.run(opts.id, opts.topic, opts.body);
    });
    try {
        txn();
        appendAuditEntry({
            action: "create",
            bulletinId: opts.id,
            agent: opts.createdBy,
            topic: opts.topic,
            urgent: opts.urgent,
            subscribers: opts.resolvedSubscribers,
        });
        return loadBulletin(opts.id);
    }
    catch (err) {
        console.error(`[bulletin-db] createBulletin failed:`, err instanceof Error ? err.message : String(err));
        return null;
    }
}
export function loadBulletin(bulletinId) {
    const db = getDb();
    const row = db.prepare("SELECT *, closed_notify, timeout_minutes FROM bulletins WHERE id = ?").get(bulletinId);
    if (!row)
        return null;
    const subs = db
        .prepare("SELECT agent_id FROM bulletin_subscribers WHERE bulletin_id = ?")
        .all(bulletinId);
    const groupNames = db
        .prepare("SELECT DISTINCT group_name FROM bulletin_subscribers WHERE bulletin_id = ? AND group_name IS NOT NULL")
        .all(bulletinId);
    const responses = db
        .prepare("SELECT * FROM bulletin_responses WHERE bulletin_id = ? AND round = 'discussion' ORDER BY created_at")
        .all(bulletinId);
    const critiques = db
        .prepare("SELECT * FROM bulletin_responses WHERE bulletin_id = ? AND round = 'critique' ORDER BY created_at")
        .all(bulletinId);
    const cursors = db
        .prepare("SELECT agent_id, last_seen_response_id FROM bulletin_cursors WHERE bulletin_id = ?")
        .all(bulletinId);
    const readCursors = {};
    for (const c of cursors)
        readCursors[c.agent_id] = c.last_seen_response_id;
    return {
        id: row.id,
        topic: row.topic,
        body: row.body,
        status: row.status,
        urgent: !!row.urgent,
        subscribers: groupNames.map((g) => g.group_name),
        resolvedSubscribers: subs.map((s) => s.agent_id),
        createdBy: row.created_by,
        createdAt: row.created_at,
        closedAt: row.closed_at ?? null,
        responses: responses.map((r) => ({
            agentId: r.agent_id,
            timestamp: r.created_at,
            body: r.body,
            position: r.position,
            reservations: r.reservations,
        })),
        readCursors,
        protocol: row.protocol,
        round: row.round,
        critiques: critiques.map((c) => ({
            agentId: c.agent_id,
            timestamp: c.created_at,
            body: c.body,
            position: c.position,
            reservations: c.reservations,
        })),
        resolution: row.resolution,
        threadId: row.thread_id,
        parentId: row.parent_id,
        closedNotify: row.closed_notify,
    };
}
/**
 * Save (patch) a bulletin — updates mutable fields like threadId, round, resolution.
 * Does NOT update responses (use addResponse for that).
 *
 * Guards:
 * - If status is 'closed' and closedAt is missing, sets closed_at to now.
 * - If topic or body changed, updates bulletins_fts (DELETE + re-INSERT).
 */
export function saveBulletin(bulletin) {
    const db = getDb();
    try {
        // Guard: ensure closed_at is set when closing
        const effectiveClosedAt = bulletin.status === "closed" && !bulletin.closedAt
            ? new Date().toISOString()
            : (bulletin.closedAt ?? null);
        // Check whether topic/body changed so we can sync FTS
        const existing = db
            .prepare("SELECT topic, body, rowid FROM bulletins WHERE id = ?")
            .get(bulletin.id);
        const topicBodyChanged = existing &&
            (existing.topic !== bulletin.topic || existing.body !== bulletin.body);
        const updateAndSyncFts = db.transaction(() => {
            db.prepare(`
        UPDATE bulletins
        SET topic = ?, body = ?, status = ?, protocol = ?, round = ?,
            urgent = ?, closed_at = ?, resolution = ?, thread_id = ?, parent_id = ?
        WHERE id = ?
      `).run(bulletin.topic, bulletin.body, bulletin.status, bulletin.protocol ?? "advisory", bulletin.round ?? "discussion", bulletin.urgent ? 1 : 0, effectiveClosedAt, bulletin.resolution ?? null, bulletin.threadId ?? null, bulletin.parentId ?? null, bulletin.id);
            // FTS content-sync: DELETE old entry + re-INSERT if topic/body changed
            if (topicBodyChanged && existing) {
                db.prepare("DELETE FROM bulletins_fts WHERE rowid = ?").run(existing.rowid);
                db.prepare("INSERT INTO bulletins_fts (rowid, id, topic, body) VALUES (?, ?, ?, ?)").run(existing.rowid, bulletin.id, bulletin.topic, bulletin.body);
            }
        });
        updateAndSyncFts();
    }
    catch (err) {
        console.error(`[bulletin-db] saveBulletin failed for ${bulletin.id}:`, err instanceof Error ? err.message : String(err));
    }
}
/**
 * Add a response to an open bulletin.
 * Validates the agent is a subscriber. Updates read cursor.
 * Performs content-sync INSERT to responses_fts.
 *
 * Returns the reloaded bulletin on success, null on failure.
 * The response count used for completion detection is computed
 * INSIDE the transaction to prevent Race #3 (stale count from
 * reload-outside-transaction).
 */
export function addResponse(bulletinId, agentId, body, position, reservations) {
    const db = getDb();
    const bulletin = loadBulletin(bulletinId);
    if (!bulletin) {
        console.error(`[bulletin-db] Bulletin not found: ${bulletinId}`);
        return null;
    }
    if (bulletin.status !== "open") {
        console.error(`[bulletin-db] Cannot respond to closed bulletin: ${bulletinId}`);
        return null;
    }
    if (!bulletin.resolvedSubscribers.includes(agentId)) {
        console.error(`[bulletin-db] Agent ${agentId} is not a subscriber of bulletin ${bulletinId}`);
        return null;
    }
    const round = bulletin.round ?? "discussion";
    const now = new Date().toISOString();
    // Check if a response already exists (for FTS update path)
    const existingResponse = db
        .prepare("SELECT id FROM bulletin_responses WHERE bulletin_id = ? AND agent_id = ? AND round = ?")
        .get(bulletinId, agentId, round);
    const insertResponse = db.prepare(`
    INSERT INTO bulletin_responses (bulletin_id, agent_id, round, position, reservations, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bulletin_id, agent_id, round) DO UPDATE SET
      position = excluded.position,
      reservations = excluded.reservations,
      body = excluded.body,
      created_at = excluded.created_at
  `);
    const txn = db.transaction(() => {
        insertResponse.run(bulletinId, agentId, round, position ?? "align", reservations ?? null, body, now);
        // FTS content-sync: responses_fts does not auto-update
        if (existingResponse) {
            // UPDATE path: DELETE old FTS entry by rowid, then re-INSERT
            try {
                db.prepare("DELETE FROM responses_fts WHERE rowid = ?").run(existingResponse.id);
            }
            catch { /* non-fatal */ }
        }
        // Always (re-)insert into FTS
        try {
            db.prepare("INSERT INTO responses_fts (bulletin_id, agent_id, body) VALUES (?, ?, ?)").run(bulletinId, agentId, body);
        }
        catch { /* non-fatal */ }
        // Update read cursor inside transaction
        const latestIdx = db.prepare("SELECT COUNT(*) - 1 as idx FROM bulletin_responses WHERE bulletin_id = ? AND round = 'discussion'").get(bulletinId);
        db.prepare(`
      INSERT INTO bulletin_cursors (bulletin_id, agent_id, last_seen_response_id)
      VALUES (?, ?, ?)
      ON CONFLICT(bulletin_id, agent_id) DO UPDATE SET last_seen_response_id = excluded.last_seen_response_id
    `).run(bulletinId, agentId, latestIdx.idx);
    });
    try {
        txn();
    }
    catch (err) {
        console.error(`[bulletin-db] addResponse failed for ${bulletinId}/${agentId}:`, err instanceof Error ? err.message : String(err));
        return null;
    }
    appendAuditEntry({ action: "respond", bulletinId, agent: agentId });
    return loadBulletin(bulletinId);
}
/**
 * Close a bulletin with a resolution.
 *
 * Uses atomic UPDATE ... WHERE status = 'open' to prevent double-close races.
 * Returns the updated bulletin if THIS caller won the race, null otherwise.
 */
export function closeBulletin(bulletinId, resolution, notes) {
    try {
        const db = getDb();
        const now = new Date().toISOString();
        const result = db.prepare("UPDATE bulletins SET status = 'closed', closed_at = ?, resolution = ? WHERE id = ? AND status = 'open'").run(now, resolution, bulletinId);
        if (result.changes === 0) {
            // Already closed by another handler, or bulletin doesn't exist
            return null;
        }
        appendAuditEntry({
            action: "close",
            bulletinId,
            resolution,
            ...(notes ? { notes } : {}),
        });
        // closedNotify is handled by the plugin layer (index.ts) after closeBulletin returns
        return loadBulletin(bulletinId);
    }
    catch (err) {
        console.error(`[bulletin-db] closeBulletin failed for ${bulletinId}:`, err instanceof Error ? err.message : String(err));
        return null;
    }
}
/**
 * Atomically transition a bulletin's round.
 *
 * Uses UPDATE ... WHERE round = expectedRound to prevent double-transition races.
 * Returns true if THIS caller won the race (changes === 1), false otherwise.
 */
export function transitionToRound(bulletinId, expectedRound, newRound) {
    try {
        const db = getDb();
        const result = db.prepare("UPDATE bulletins SET round = ? WHERE id = ? AND round = ? AND status = 'open'").run(newRound, bulletinId, expectedRound);
        return result.changes > 0;
    }
    catch (err) {
        console.error(`[bulletin-db] transitionToRound failed for ${bulletinId}:`, err instanceof Error ? err.message : String(err));
        return false;
    }
}
/**
 * Get the count of responses for a given bulletin and round.
 * Used for race-safe completion detection after addResponse commits.
 */
export function getResponseCount(bulletinId, round) {
    try {
        const db = getDb();
        const row = db.prepare("SELECT COUNT(*) as cnt FROM bulletin_responses WHERE bulletin_id = ? AND round = ?").get(bulletinId, round);
        return row?.cnt ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * Get the subscriber count for a bulletin.
 */
export function getSubscriberCount(bulletinId) {
    try {
        const db = getDb();
        const row = db.prepare("SELECT COUNT(*) as cnt FROM bulletin_subscribers WHERE bulletin_id = ?").get(bulletinId);
        return row?.cnt ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * Update the read cursor for an agent on a bulletin.
 */
export function updateReadCursor(bulletinId, agentId, cursorIndex) {
    const db = getDb();
    try {
        db.prepare(`
      INSERT INTO bulletin_cursors (bulletin_id, agent_id, last_seen_response_id)
      VALUES (?, ?, ?)
      ON CONFLICT(bulletin_id, agent_id) DO UPDATE SET last_seen_response_id = excluded.last_seen_response_id
    `).run(bulletinId, agentId, cursorIndex);
        return loadBulletin(bulletinId);
    }
    catch (err) {
        console.error(`[bulletin-db] updateReadCursor failed for ${bulletinId}/${agentId}:`, err instanceof Error ? err.message : String(err));
        return null;
    }
}
// ── Query helpers ───────────────────────────────────────────────────────────
/**
 * Get all open bulletins where the given agent is a resolved subscriber.
 */
export function getOpenBulletinsForAgent(agentId) {
    const db = getDb();
    try {
        const rows = db
            .prepare(`
        SELECT DISTINCT b.id FROM bulletins b
        JOIN bulletin_subscribers s ON b.id = s.bulletin_id
        WHERE b.status = 'open' AND s.agent_id = ?
        ORDER BY b.created_at ASC
      `)
            .all(agentId);
        return rows.map((r) => loadBulletin(r.id)).filter(Boolean);
    }
    catch (err) {
        console.error(`[bulletin-db] getOpenBulletinsForAgent failed:`, err instanceof Error ? err.message : String(err));
        return [];
    }
}
/**
 * Get open bulletins where the given agent is a subscriber but has NOT
 * yet submitted a response for the current round.
 */
export function getUnrespondedBulletins(agentId, opts) {
    const db = getDb();
    try {
        let sql = `
      SELECT DISTINCT b.id FROM bulletins b
      JOIN bulletin_subscribers s ON b.id = s.bulletin_id
      WHERE b.status = 'open' AND s.agent_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM bulletin_responses r
        WHERE r.bulletin_id = b.id
        AND r.agent_id = ?
        AND r.round = b.round
      )
    `;
        const params = [agentId, agentId];
        if (opts?.urgent !== undefined) {
            sql += ` AND b.urgent = ?`;
            params.push(opts.urgent ? 1 : 0);
        }
        sql += " ORDER BY b.created_at ASC";
        const rows = db.prepare(sql).all(...params);
        return rows.map((r) => loadBulletin(r.id)).filter(Boolean);
    }
    catch (err) {
        console.error(`[bulletin-db] getUnrespondedBulletins failed:`, err instanceof Error ? err.message : String(err));
        return [];
    }
}
/**
 * Get all urgent, open bulletins that have unread responses for the given agent.
 */
export function getUnreadUrgentBulletins(agentId) {
    const db = getDb();
    try {
        const rows = db
            .prepare(`
        SELECT DISTINCT b.id FROM bulletins b
        JOIN bulletin_subscribers s ON b.id = s.bulletin_id
        LEFT JOIN bulletin_cursors c ON c.bulletin_id = b.id AND c.agent_id = ?
        LEFT JOIN (
          SELECT bulletin_id, MAX(id) as max_response_id
          FROM bulletin_responses WHERE round = 'discussion'
          GROUP BY bulletin_id
        ) latest ON latest.bulletin_id = b.id
        WHERE b.status = 'open' AND b.urgent = 1 AND s.agent_id = ?
        AND (
          c.last_seen_response_id IS NULL
          OR c.last_seen_response_id < COALESCE(latest.max_response_id, 0)
          OR (c.last_seen_response_id = -1)
        )
        ORDER BY b.created_at ASC
      `)
            .all(agentId, agentId);
        return rows.map((r) => loadBulletin(r.id)).filter(Boolean);
    }
    catch (err) {
        console.error(`[bulletin-db] getUnreadUrgentBulletins failed:`, err instanceof Error ? err.message : String(err));
        return [];
    }
}
/**
 * List bulletins with optional status and agent filter.
 */
export function listBulletins(opts) {
    const db = getDb();
    try {
        let sql = "SELECT DISTINCT b.id FROM bulletins b";
        const params = [];
        if (opts?.agentId) {
            sql += " JOIN bulletin_subscribers s ON b.id = s.bulletin_id";
        }
        const wheres = [];
        if (opts?.status && opts.status !== "all") {
            wheres.push("b.status = ?");
            params.push(opts.status);
        }
        if (opts?.agentId) {
            wheres.push("s.agent_id = ?");
            params.push(opts.agentId);
        }
        if (wheres.length)
            sql += " WHERE " + wheres.join(" AND ");
        sql += " ORDER BY b.created_at DESC LIMIT ?";
        params.push(opts?.limit ?? 20);
        const rows = db.prepare(sql).all(...params);
        return rows.map((r) => loadBulletin(r.id)).filter(Boolean);
    }
    catch (err) {
        console.error(`[bulletin-db] listBulletins failed:`, err instanceof Error ? err.message : String(err));
        return [];
    }
}
/**
 * Full-text search across bulletin topics, bodies, and responses.
 */
export function searchBulletins(query, limit = 10) {
    const db = getDb();
    try {
        const rows = db
            .prepare(`
        SELECT id as id FROM bulletins_fts WHERE bulletins_fts MATCH ?
        UNION
        SELECT DISTINCT bulletin_id as id FROM responses_fts WHERE responses_fts MATCH ?
        LIMIT ?
      `)
            .all(query, query, limit);
        return rows.map((r) => loadBulletin(r.id)).filter(Boolean);
    }
    catch (err) {
        console.error(`[bulletin-db] searchBulletins failed:`, err instanceof Error ? err.message : String(err));
        return [];
    }
}
/**
 * Generate the next sub-bulletin ID for a given parent.
 */
export function nextSubBulletinId(parentId) {
    const db = getDb();
    try {
        const rows = db
            .prepare("SELECT id FROM bulletins WHERE parent_id = ?")
            .all(parentId);
        const pattern = new RegExp(`^${parentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-sub-(\\d+)$`);
        let maxN = 0;
        for (const row of rows) {
            const match = row.id.match(pattern);
            if (match) {
                const n = parseInt(match[1], 10);
                if (n > maxN)
                    maxN = n;
            }
        }
        return `${parentId}-sub-${maxN + 1}`;
    }
    catch {
        return `${parentId}-sub-1`;
    }
}
// ── Rendering ───────────────────────────────────────────────────────────────
/**
 * Render all pending (unresponded) bulletins for an agent as markdown.
 * This is the content previously injected as BULLETINS.md.
 * Returns null if no pending bulletins.
 */
export function renderBulletinsForAgent(agentId) {
    const pending = getUnrespondedBulletins(agentId);
    if (pending.length === 0)
        return null;
    const lines = ["# Pending Bulletins", ""];
    for (const bulletin of pending) {
        const round = bulletin.round ?? "discussion";
        const urgentTag = bulletin.urgent ? " 🚨 URGENT" : "";
        const protocolTag = bulletin.protocol ? ` [${bulletin.protocol.toUpperCase()}]` : "";
        lines.push(`## Bulletin: ${bulletin.id}${urgentTag}${protocolTag}`);
        lines.push(`**Topic:** ${bulletin.topic}`);
        lines.push(`**From:** ${bulletin.createdBy}`);
        lines.push(`**Created:** ${bulletin.createdAt}`);
        lines.push(`**Round:** ${round}`);
        lines.push(`**Subscribers:** ${bulletin.resolvedSubscribers.join(", ")}`);
        lines.push("");
        lines.push(bulletin.body);
        lines.push("");
        if (bulletin.responses.length > 0) {
            lines.push("### Responses so far");
            for (const r of bulletin.responses) {
                const posTag = r.position ? ` [${r.position.toUpperCase()}]` : "";
                lines.push(`**${r.agentId}**${posTag} (${r.timestamp}):`);
                lines.push(r.body);
                if (r.reservations) {
                    lines.push(`*Reservations: ${r.reservations}*`);
                }
                lines.push("");
            }
        }
        if (round === "critique" && (bulletin.critiques ?? []).length > 0) {
            lines.push("### Critiques so far");
            for (const c of bulletin.critiques ?? []) {
                const posTag = c.position ? ` [${c.position.toUpperCase()}]` : "";
                lines.push(`**${c.agentId}**${posTag} (${c.timestamp}):`);
                lines.push(c.body);
                if (c.reservations) {
                    lines.push(`*Reservations: ${c.reservations}*`);
                }
                lines.push("");
            }
        }
        if (round === "discussion") {
            lines.push(`> Use \`bulletin_respond\` to respond to bulletin \`${bulletin.id}\`.`);
        }
        else {
            lines.push(`> Use \`bulletin_critique\` to submit your critique of bulletin \`${bulletin.id}\`.`);
        }
        lines.push("");
        lines.push("---");
        lines.push("");
    }
    return lines.join("\n");
}
// ── Audit ───────────────────────────────────────────────────────────────────
export function appendAuditEntry(data) {
    if (!existsSync(BULLETINS_DIR)) {
        mkdirSync(BULLETINS_DIR, { recursive: true });
    }
    const entry = JSON.stringify({ ts: new Date().toISOString(), ...data });
    try {
        appendFileSync(AUDIT_LOG_PATH, entry + "\n");
    }
    catch (err) {
        console.error("[bulletin-db] Failed to write audit log:", err instanceof Error ? err.message : String(err));
    }
}
//# sourceMappingURL=bulletin-db.js.map