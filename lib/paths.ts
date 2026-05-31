import { homedir } from "node:os";
import { join } from "node:path";

export function getOpenClawHome(): string {
  return process.env.OPENCLAW_HOME || join(process.env.HOME || homedir(), ".openclaw");
}

export function getMailroomDir(): string {
  return join(getOpenClawHome(), "mailroom");
}

export function getBulletinsDir(): string {
  return join(getMailroomDir(), "bulletins");
}

export function getBulletinDbPath(): string {
  return join(getBulletinsDir(), "bulletins.db");
}

export function getBulletinAuditLogPath(): string {
  return join(getBulletinsDir(), "audit.log");
}

export function getDbAuditLogPath(): string {
  return join(getBulletinsDir(), "bulletins.log");
}

export function getMailroomLogPath(): string {
  return join(getMailroomDir(), "mailroom.log");
}

export function getBulletinConfigPath(): string {
  return join(getMailroomDir(), "bulletin-config.json");
}

export function getAgentGroupsPath(): string {
  return join(getMailroomDir(), "agent-groups.json");
}

export function getOpenClawConfigPath(): string {
  return join(getOpenClawHome(), "openclaw.json");
}

export function getSecretsJsonPath(): string {
  return join(getOpenClawHome(), "secrets.json");
}

export function getEnvPath(): string {
  return join(getOpenClawHome(), ".env");
}
