import { existsSync, readFileSync } from "node:fs";
import { getAgentGroupsPath, getOpenClawConfigPath, } from "./paths.js";
function readJsonFile(path) {
    return JSON.parse(readFileSync(path, "utf-8"));
}
export function loadAgentGroups() {
    try {
        const data = readJsonFile(getAgentGroupsPath());
        const rawGroups = data.agentGroups && typeof data.agentGroups === "object"
            ? data.agentGroups
            : data;
        const groups = {};
        for (const [name, members] of Object.entries(rawGroups)) {
            if (Array.isArray(members)) {
                groups[name] = members.filter((member) => typeof member === "string");
            }
        }
        return groups;
    }
    catch {
        return {};
    }
}
export function loadKnownAgentIds() {
    try {
        if (!existsSync(getOpenClawConfigPath()))
            return [];
        const config = readJsonFile(getOpenClawConfigPath());
        return (config.agents?.list ?? [])
            .map((agent) => agent.id)
            .filter((id) => typeof id === "string" && id.length > 0);
    }
    catch {
        return [];
    }
}
export function resolveBulletinSubscribers(requested, opts = {}) {
    const groups = loadAgentGroups();
    const knownAgents = loadKnownAgentIds();
    const knownAgentSet = new Set(knownAgents);
    const resolved = new Set();
    const unknown = new Set();
    for (const rawName of requested) {
        const name = rawName.trim();
        if (!name)
            continue;
        const members = groups[name];
        if (members) {
            for (const member of members) {
                if (member === "*") {
                    for (const agentId of knownAgents) {
                        resolved.add(agentId);
                    }
                }
                else {
                    resolved.add(member);
                }
            }
            continue;
        }
        if (knownAgentSet.has(name)) {
            resolved.add(name);
            continue;
        }
        unknown.add(name);
        if (opts.allowUnknown === true) {
            resolved.add(name);
        }
    }
    return {
        requested: requested.map((name) => name.trim()).filter(Boolean),
        resolved: Array.from(resolved),
        unknown: Array.from(unknown),
        knownAgents,
        groups,
    };
}
//# sourceMappingURL=subscribers.js.map