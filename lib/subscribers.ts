import { existsSync, readFileSync } from "node:fs";
import {
  getAgentGroupsPath,
  getOpenClawConfigPath,
} from "./paths.ts";

export type SubscriberResolution = {
  requested: string[];
  resolved: string[];
  unknown: string[];
  knownAgents: string[];
  groups: Record<string, string[]>;
};

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadAgentGroups(): Record<string, string[]> {
  try {
    const data = readJsonFile(getAgentGroupsPath()) as {
      agentGroups?: Record<string, string[]>;
      [key: string]: unknown;
    };
    const rawGroups = data.agentGroups && typeof data.agentGroups === "object"
      ? data.agentGroups
      : data;
    const groups: Record<string, string[]> = {};
    for (const [name, members] of Object.entries(rawGroups)) {
      if (Array.isArray(members)) {
        groups[name] = members.filter((member): member is string => typeof member === "string");
      }
    }
    return groups;
  } catch {
    return {};
  }
}

export function loadKnownAgentIds(): string[] {
  try {
    if (!existsSync(getOpenClawConfigPath())) return [];
    const config = readJsonFile(getOpenClawConfigPath()) as {
      agents?: { list?: Array<{ id?: unknown }> };
    };
    return (config.agents?.list ?? [])
      .map((agent) => agent.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

export function resolveBulletinSubscribers(
  requested: string[],
  opts: { allowUnknown?: boolean } = {},
): SubscriberResolution {
  const groups = loadAgentGroups();
  const knownAgents = loadKnownAgentIds();
  const knownAgentSet = new Set(knownAgents);
  const resolved = new Set<string>();
  const unknown = new Set<string>();

  for (const rawName of requested) {
    const name = rawName.trim();
    if (!name) continue;

    const members = groups[name];
    if (members) {
      for (const member of members) {
        if (member === "*") {
          for (const agentId of knownAgents) {
            resolved.add(agentId);
          }
        } else {
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
