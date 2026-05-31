#!/usr/bin/env node
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { loadConfiguredSecretVars, loadBulletinConfig, resolveConfigToken, } from "../lib/config.js";
import { getBulletinConfigPath, getBulletinsDir, getMailroomLogPath, getOpenClawConfigPath, } from "../lib/paths.js";
import { createBulletin, getDb, loadBulletin, nextSubBulletinId, } from "../lib/bulletin-db.js";
import { resolveBulletinSubscribers, } from "../lib/subscribers.js";
// Discord helper: post a message to a channel, return { ok, messageId }
function discordPost(channelId, content, token) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({ content });
        const req = https.request({
            hostname: 'discord.com',
            path: `/api/v10/channels/${channelId}/messages`,
            method: 'POST',
            headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve({ ok: true, messageId: JSON.parse(body).id });
                    }
                    catch {
                        resolve({ ok: true, messageId: null });
                    }
                }
                else {
                    resolve({ ok: false, error: `${res.statusCode}: ${body.slice(0, 200)}` });
                }
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.write(postData);
        req.end();
    });
}
// Discord helper: create a thread from a message, return threadId or null
function discordCreateThread(channelId, messageId, name, token) {
    return new Promise((resolve) => {
        const threadData = JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: 10080 });
        const req = https.request({
            hostname: 'discord.com',
            path: `/api/v10/channels/${channelId}/messages/${messageId}/threads`,
            method: 'POST',
            headers: {
                Authorization: `Bot ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(threadData),
            },
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(JSON.parse(body).id || null);
                    }
                    catch {
                        resolve(null);
                    }
                }
                else {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.write(threadData);
        req.end();
    });
}
function loadSecrets() {
    return loadConfiguredSecretVars();
}
function resolveGatewayAuth() {
    const secrets = loadSecrets();
    try {
        const bltCfg = loadBulletinConfig();
        const token = resolveConfigToken(bltCfg?.gatewayToken, secrets);
        if (token)
            return token;
    }
    catch { }
    return process.env.GATEWAY_AUTH_TOKEN || secrets.GATEWAY_AUTH_TOKEN;
}
function resolveGatewayPort() {
    if (process.env.OPENCLAW_GATEWAY_PORT)
        return parseInt(process.env.OPENCLAW_GATEWAY_PORT, 10) || 18789;
    try {
        const cfg = JSON.parse(fs.readFileSync(getOpenClawConfigPath(), 'utf8'));
        return cfg.gateway?.port ?? 18789;
    }
    catch {
        return 18789;
    }
}
function wakeViaGateway(agentId, bulletinId, label) {
    const port = resolveGatewayPort();
    const token = resolveGatewayAuth();
    const payload = JSON.stringify({
        agentId,
        bulletinIds: [bulletinId],
        label: `${label}-${agentId}`,
    });
    return new Promise((resolve) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/bulletin/wake',
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 20000,
        }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.ok) {
                            resolve({ ok: true, output: body });
                        }
                        else {
                            resolve({ ok: false, error: parsed.error?.message || body.slice(0, 200) });
                        }
                    }
                    catch {
                        resolve({ ok: true, output: body });
                    }
                }
                else {
                    resolve({ ok: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
                }
            });
        });
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
        req.write(payload);
        req.end();
    });
}
// --- Paths ---
const BULLETINS_DIR = getBulletinsDir();
const LOG_PATH = getMailroomLogPath();
// --- Arg parsing ---
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf('--' + name);
    if (idx === -1)
        return undefined;
    return args[idx + 1];
}
function hasFlag(name) {
    return args.includes('--' + name);
}
const topic = getArg('topic');
const body = getArg('body');
const subscribersRaw = getArg('subscribers');
const urgent = hasFlag('urgent');
const customId = getArg('id');
const parentId = getArg('parent');
const protocol = getArg('protocol');
const timeout = getArg('timeout');
const closedNotify = getArg('closed-notify');
if (!topic || !body || !subscribersRaw) {
    console.error('Usage: bulletin-post --topic "Topic" --body "Body" --subscribers "group1,group2" [--urgent] [--id "custom-id"] [--parent "parent-id"] [--protocol advisory|fyi|consensus|majority] [--timeout minutes] [--closed-notify "channel:ID"]');
    process.exit(1);
}
const subscriberGroups = subscribersRaw.split(',').map(s => s.trim()).filter(Boolean);
const subscriberResolution = resolveBulletinSubscribers(subscriberGroups, { allowUnknown: true });
const resolvedSubscribers = subscriberResolution.resolved;
const VALID_PROTOCOLS = ['advisory', 'fyi', 'consensus', 'majority'];
if (protocol && !VALID_PROTOCOLS.includes(protocol)) {
    console.error(`Error: Invalid protocol "${protocol}". Must be one of: ${VALID_PROTOCOLS.join(', ')}`);
    process.exit(1);
}
// --- Validate parent if specified ---
let resolvedParentId = null;
if (parentId) {
    if (!loadBulletin(parentId)) {
        console.error(`Error: Parent bulletin "${parentId}" not found in SQLite`);
        process.exit(1);
    }
    resolvedParentId = parentId;
}
// --- Create bulletin ---
const now = new Date().toISOString();
let id = customId || `blt-${Date.now()}`;
if (resolvedParentId && !customId) {
    id = nextSubBulletinId(resolvedParentId);
}
const readCursors = {};
for (const agentId of resolvedSubscribers) {
    readCursors[agentId] = -1;
}
const bulletin = {
    id,
    topic,
    body,
    status: 'open',
    protocol: protocol || 'advisory',
    round: 'discussion',
    urgent: urgent || false,
    subscribers: subscriberGroups,
    resolvedSubscribers,
    createdBy: process.env.USER || 'cli',
    createdAt: now,
    closedAt: null,
    responses: [],
    readCursors,
    ...(resolvedParentId ? { parentId: resolvedParentId } : {}),
    ...(closedNotify ? { closedNotify } : {}),
    ...(timeout ? { timeoutMinutes: parseInt(timeout, 10) } : {}),
};
// Ensure bulletins dir exists
fs.mkdirSync(BULLETINS_DIR, { recursive: true });
// Write bulletin to SQLite DB
const created = createBulletin({
    id,
    topic,
    body,
    urgent: urgent || false,
    subscribers: subscriberGroups,
    resolvedSubscribers,
    createdBy: 'bulletin-post',
    protocol: protocol || 'advisory',
    parentId: resolvedParentId || undefined,
    closedNotify: closedNotify || undefined,
    timeoutMinutes: timeout ? parseInt(timeout, 10) : undefined,
});
if (!created) {
    console.error('Error: SQLite write failed.');
    process.exit(1);
}
// Write bulletin file (JSON backup)
const bulletinPath = path.join(BULLETINS_DIR, `${id}.json`);
fs.writeFileSync(bulletinPath, JSON.stringify(bulletin, null, 2) + '\n');
// --- Append to audit log ---
const logEntry = {
    ts: now,
    action: 'bulletin-post',
    id,
    topic,
    resolvedSubscribers,
    urgent: urgent || false
};
fs.appendFileSync(LOG_PATH, JSON.stringify(logEntry) + '\n');
// --- Async: create Discord thread + notify subscribers ---
(async () => {
    let threadId = null;
    try {
        const bltCfgPath = getBulletinConfigPath();
        if (fs.existsSync(bltCfgPath)) {
            const bltCfg = loadBulletinConfig();
            if (!bltCfg)
                return;
            const secrets = loadSecrets();
            const botToken = bltCfg.botToken
                ? (resolveConfigToken(bltCfg.botToken, secrets) || bltCfg.botToken)
                : undefined;
            const boardChannel = bltCfg.bulletinBoardChannel;
            if (botToken && boardChannel) {
                const threadBody = [
                    `📋 **[${id}] ${topic}**`,
                    `*Protocol: ${protocol || 'advisory'} | Subscribers: ${resolvedSubscribers.join(', ')}*`,
                    '',
                    body,
                    '',
                    '*Respond using `bulletin_respond` tool.*',
                ].join('\n');
                const postResult = await discordPost(boardChannel, threadBody, botToken);
                if (postResult.ok && postResult.messageId) {
                    threadId = await discordCreateThread(boardChannel, postResult.messageId, `[${id}] ${topic}`, botToken);
                    if (threadId) {
                        try {
                            const bulletinData = JSON.parse(fs.readFileSync(bulletinPath, 'utf8'));
                            bulletinData.threadId = threadId;
                            fs.writeFileSync(bulletinPath, JSON.stringify(bulletinData, null, 2) + '\n');
                        }
                        catch (e) {
                            console.error('Warning: could not save threadId to bulletin JSON:', e.message);
                        }
                        // Also update SQLite so bulletin_respond can find the threadId
                        // Default closedNotify to the thread if not explicitly set
                        try {
                            const db2 = getDb();
                            db2.prepare('UPDATE bulletins SET thread_id = ? WHERE id = ?').run(threadId, id);
                            if (!closedNotify) {
                                db2.prepare('UPDATE bulletins SET closed_notify = ? WHERE id = ?').run(`channel:${threadId}`, id);
                            }
                        }
                        catch (e) {
                            console.error('Warning: could not save threadId to SQLite:', e.message);
                        }
                    }
                }
            }
            for (const agentId of resolvedSubscribers) {
                const result = await wakeViaGateway(agentId, id, id);
                if (result.ok) {
                    console.log(`  Woke:        ${agentId}`);
                }
                else {
                    console.log(`  Wake fail:   ${agentId} (${result.error})`);
                }
            }
        }
    }
    catch (e) {
        console.error('Warning: Discord notification failed:', e.message);
    }
    console.log(`Bulletin posted successfully.`);
    console.log(`  ID:          ${id}`);
    console.log(`  Topic:       ${topic}`);
    console.log(`  Urgent:      ${urgent ? 'YES' : 'no'}`);
    console.log(`  Groups:      ${subscriberGroups.join(', ')}`);
    console.log(`  Subscribers: ${resolvedSubscribers.join(', ')}`);
    if (resolvedParentId) {
        console.log(`  Parent:      ${resolvedParentId}`);
    }
    console.log(`  Protocol:    ${protocol || 'advisory'}`);
    if (timeout) {
        console.log(`  Timeout:     ${timeout} minutes`);
    }
    if (closedNotify) {
        console.log(`  ClosedNotify:${closedNotify}`);
    }
    if (threadId) {
        try {
            const bltCfg2 = JSON.parse(fs.readFileSync(getBulletinConfigPath(), 'utf8'));
            if (bltCfg2.serverId) {
                console.log(`  Thread:      https://discord.com/channels/${bltCfg2.serverId}/${threadId}`);
            }
            else {
                console.log(`  Thread:      ${threadId}`);
            }
        }
        catch {
            console.log(`  Thread:      ${threadId}`);
        }
    }
})();
//# sourceMappingURL=bulletin-post.js.map