/**
 * Discord notification helper — raw HTTPS posting.
 *
 * Copied from agent-coordinator/lib/discord-notify.ts to make the plugin
 * self-contained. Long-term these should go through OpenClaw's message tool
 * so the plugin isn't Discord-specific.
 */

import * as https from "node:https";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const MAILROOM_LOG = join(homedir(), ".openclaw", "mailroom", "mailroom.log");

function logToMailroom(message: string): void {
  try {
    appendFileSync(MAILROOM_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch { /* best effort */ }
}

export interface DiscordPostResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Post a message to a Discord channel via bot token.
 *
 * Returns the message ID on success for reaction seeding.
 * On failure, logs to mailroom.log and returns { ok: false }.
 * Never throws — callers should not need try/catch.
 */
export async function postToDiscord(
  channelId: string,
  content: string,
  botToken: string,
): Promise<DiscordPostResult> {
  const postData = JSON.stringify({ content });

  return new Promise<DiscordPostResult>((resolve) => {
    const req = https.request(
      {
        hostname: "discord.com",
        path: `/api/v10/channels/${channelId}/messages`,
        method: "POST",
        headers: {
          Authorization: `Bot ${botToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: any) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const d = JSON.parse(body);
              resolve({ ok: true, messageId: d.id || "" });
            } catch {
              resolve({ ok: true, messageId: "" });
            }
          } else {
            const error = `Discord API ${res.statusCode}: ${body.slice(0, 200)}`;
            logToMailroom(`[discord-notify] POST failed: ${error}`);
            console.error(`[discord-notify] ${error}`);
            resolve({ ok: false, error });
          }
        });
      },
    );

    req.on("error", (err) => {
      const error = `Network error: ${err.message}`;
      logToMailroom(`[discord-notify] POST failed: ${error}`);
      console.error(`[discord-notify] ${error}`);
      resolve({ ok: false, error });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Post a message to an existing Discord thread.
 * Discord threads are channels — same POST /channels/{id}/messages endpoint.
 * Best-effort: never throws.
 */
export async function postToThread(
  threadId: string,
  content: string,
  botToken: string,
): Promise<void> {
  const result = await postToDiscord(threadId, content, botToken);
  if (!result.ok) {
    console.error(`[discord-notify] postToThread failed for thread ${threadId}: ${result.error}`);
  }
}
