import { homedir } from "node:os";
import { join } from "node:path";
export function getOpenClawHome() {
    return process.env.OPENCLAW_HOME || join(process.env.HOME || homedir(), ".openclaw");
}
export function getMailroomDir() {
    return join(getOpenClawHome(), "mailroom");
}
export function getBulletinsDir() {
    return join(getMailroomDir(), "bulletins");
}
export function getBulletinDbPath() {
    return join(getBulletinsDir(), "bulletins.db");
}
export function getBulletinAuditLogPath() {
    return join(getBulletinsDir(), "audit.log");
}
export function getDbAuditLogPath() {
    return join(getBulletinsDir(), "bulletins.log");
}
export function getMailroomLogPath() {
    return join(getMailroomDir(), "mailroom.log");
}
export function getBulletinConfigPath() {
    return join(getMailroomDir(), "bulletin-config.json");
}
export function getAgentGroupsPath() {
    return join(getMailroomDir(), "agent-groups.json");
}
export function getOpenClawConfigPath() {
    return join(getOpenClawHome(), "openclaw.json");
}
export function getSecretsJsonPath() {
    return join(getOpenClawHome(), "secrets.json");
}
export function getEnvPath() {
    return join(getOpenClawHome(), ".env");
}
//# sourceMappingURL=paths.js.map