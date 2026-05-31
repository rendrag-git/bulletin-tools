#!/usr/bin/env node

import fs from 'node:fs';
import {
  loadConfiguredSecretVars,
  loadBulletinConfig,
  loadEnvFile,
  loadSecretsJson,
  resolveConfigToken,
} from '../lib/config.ts';
import {
  getAgentGroupsPath,
  getBulletinConfigPath,
  getBulletinDbPath,
  getBulletinsDir,
  getEnvPath,
  getMailroomDir,
  getOpenClawConfigPath,
  getOpenClawHome,
  getSecretsJsonPath,
} from '../lib/paths.ts';

const checks = [];

function check(name, ok, detail, required = true) {
  checks.push({ name, ok, detail, required });
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

const nodeVersion = process.versions.node.split('.').map((part) => Number(part));
const nodeMajor = nodeVersion[0] ?? 0;
const nodeMinor = nodeVersion[1] ?? 0;
const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 18);
check('node version', nodeOk, `${process.version} (requires >=22.18.0)`);

try {
  await import('better-sqlite3');
  check('better-sqlite3 binding', true, 'loadable');
} catch (err) {
  check('better-sqlite3 binding', false, err instanceof Error ? err.message : String(err));
}

const openclawHome = getOpenClawHome();
check('OPENCLAW_HOME', true, openclawHome, false);
check('mailroom directory', fs.existsSync(getMailroomDir()), getMailroomDir());
check('bulletins directory', fs.existsSync(getBulletinsDir()), getBulletinsDir(), false);
check('openclaw config', fs.existsSync(getOpenClawConfigPath()), getOpenClawConfigPath(), false);

let config = null;
try {
  config = loadBulletinConfig();
  check('bulletin config', !!config, getBulletinConfigPath());
} catch (err) {
  check('bulletin config', false, `${getBulletinConfigPath()}: ${err instanceof Error ? err.message : String(err)}`);
}

let groups = null;
try {
  groups = readJson(getAgentGroupsPath());
  const agentGroups = groups.agentGroups || groups;
  check('agent groups', agentGroups && typeof agentGroups === 'object', `${Object.keys(agentGroups ?? {}).length} groups`);
} catch (err) {
  check('agent groups', false, `${getAgentGroupsPath()}: ${err instanceof Error ? err.message : String(err)}`);
}

const envVars = loadEnvFile();
const secretsJson = loadSecretsJson();
const configuredSecretVars = loadConfiguredSecretVars();
const secretSources = [
  fs.existsSync(getEnvPath()) ? getEnvPath() : null,
  fs.existsSync(getSecretsJsonPath()) ? getSecretsJsonPath() : null,
].filter(Boolean);
check('secret sources', secretSources.length > 0, secretSources.join(', ') || 'process.env only', false);

if (config) {
  const platform = config.platform || 'discord';
  check('platform', platform === 'discord', `${platform} (only discord is currently tested)`, platform === 'discord');
  check('bulletinBoardChannel', !!config.bulletinBoardChannel, config.bulletinBoardChannel || 'missing');
  check('escalationChannel', !!config.escalationChannel, config.escalationChannel || 'missing');

  const botToken = resolveConfigToken(config.botToken, configuredSecretVars);
  check('bot token', !!botToken, config.botToken ? 'configured' : 'missing');

  const gatewayToken = resolveConfigToken(config.gatewayToken, configuredSecretVars);
  check('gateway token', !!gatewayToken, config.gatewayToken ? 'configured' : 'missing', false);
}

check('sqlite database path', true, getBulletinDbPath(), false);

for (const result of checks) {
  const marker = result.ok ? 'ok' : result.required ? 'fail' : 'warn';
  console.log(`${marker.padEnd(5)} ${result.name}: ${result.detail}`);
}

const failed = checks.filter((result) => result.required && !result.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed.`);
  process.exit(1);
}

console.log('\nAll required checks passed.');
