import { existsSync, readFileSync } from "node:fs";
import {
  getBulletinConfigPath,
  getEnvPath,
  getSecretsJsonPath,
} from "./paths.ts";

export function loadEnvFile(): Record<string, string> {
  try {
    const vars: Record<string, string> = {};
    const content = readFileSync(getEnvPath(), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
    return vars;
  } catch {
    return {};
  }
}

export function loadSecretsJson(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(getSecretsJsonPath(), "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function loadConfiguredSecretVars(): Record<string, string> {
  return {
    ...loadEnvFile(),
    ...loadSecretsJson(),
  };
}

export function resolveConfigToken(
  rawToken: string | undefined,
  extraVars: Record<string, string> = {},
): string | undefined {
  if (!rawToken) return undefined;
  const match = rawToken.match(/^\$\{([^}]+)\}$/);
  if (!match) return rawToken;
  const varName = match[1];
  return process.env[varName] ?? extraVars[varName] ?? loadSecretsJson()[varName] ?? loadEnvFile()[varName];
}

export interface BulletinConfig {
  platform?: string;
  bulletinBoardChannel?: string;
  escalationChannel?: string;
  botToken?: string;
  gatewayToken?: string;
  dissentThreshold?: number;
  consensusPartialThreshold?: number;
  serverId?: string;
  accountId?: string;
}

export function loadBulletinConfig(): BulletinConfig | null {
  const path = getBulletinConfigPath();
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as BulletinConfig;
}
