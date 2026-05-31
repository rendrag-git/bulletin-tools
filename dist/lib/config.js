import { existsSync, readFileSync } from "node:fs";
import { getBulletinConfigPath, getEnvPath, getSecretsJsonPath, } from "./paths.js";
export function loadEnvFile() {
    try {
        const vars = {};
        const content = readFileSync(getEnvPath(), "utf-8");
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
                continue;
            const idx = trimmed.indexOf("=");
            vars[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
        }
        return vars;
    }
    catch {
        return {};
    }
}
export function loadSecretsJson() {
    try {
        return JSON.parse(readFileSync(getSecretsJsonPath(), "utf-8"));
    }
    catch {
        return {};
    }
}
export function loadConfiguredSecretVars() {
    return {
        ...loadEnvFile(),
        ...loadSecretsJson(),
    };
}
export function resolveConfigToken(rawToken, extraVars = {}) {
    if (!rawToken)
        return undefined;
    const match = rawToken.match(/^\$\{([^}]+)\}$/);
    if (!match)
        return rawToken;
    const varName = match[1];
    return process.env[varName] ?? extraVars[varName] ?? loadSecretsJson()[varName] ?? loadEnvFile()[varName];
}
export function loadBulletinConfig() {
    const path = getBulletinConfigPath();
    if (!existsSync(path))
        return null;
    return JSON.parse(readFileSync(path, "utf-8"));
}
//# sourceMappingURL=config.js.map