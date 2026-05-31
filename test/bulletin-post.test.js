import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');
const cliPath = path.join(repoRoot, 'bin', 'bulletin-post');
const doctorPath = path.join(repoRoot, 'bin', 'bulletin-doctor');

function createOpenClawHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bulletin-tools-'));
  const openclawDir = path.join(home, 'openclaw-home');
  const mailroomDir = path.join(openclawDir, 'mailroom');

  fs.mkdirSync(mailroomDir, { recursive: true });
  fs.writeFileSync(
    path.join(openclawDir, 'openclaw.json'),
    JSON.stringify({ agents: { list: [{ id: 'dev' }, { id: 'pm' }] } }),
  );
  fs.writeFileSync(
    path.join(mailroomDir, 'agent-groups.json'),
    JSON.stringify({ engineering: ['dev', 'pm'] }),
  );
  return { home, openclawDir, mailroomDir };
}

test('bulletin-post creates a bulletin in SQLite with a temporary OpenClaw home', async () => {
  const { home, openclawDir, mailroomDir } = createOpenClawHome();

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      cliPath,
      '--id',
      'test-bulletin',
      '--topic',
      'Test bulletin',
      '--body',
      'This is a test bulletin.',
      '--subscribers',
      'engineering',
      '--protocol',
      'advisory',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawDir,
      },
    },
  );

  assert.match(stdout, /Bulletin posted successfully/);
  assert.match(stdout, /Subscribers: dev, pm/);

  const db = new Database(path.join(mailroomDir, 'bulletins', 'bulletins.db'), { readonly: true });
  try {
    const bulletin = db
      .prepare('SELECT id, topic, protocol, status FROM bulletins WHERE id = ?')
      .get('test-bulletin');
    assert.deepEqual(bulletin, {
      id: 'test-bulletin',
      topic: 'Test bulletin',
      protocol: 'advisory',
      status: 'open',
    });

    const subscribers = db
      .prepare('SELECT agent_id FROM bulletin_subscribers WHERE bulletin_id = ? ORDER BY agent_id')
      .all('test-bulletin')
      .map((row) => row.agent_id);
    assert.deepEqual(subscribers, ['dev', 'pm']);

    const fts = db
      .prepare("SELECT id FROM bulletins_fts WHERE bulletins_fts MATCH 'bulletin'")
      .all()
      .map((row) => row.id);
    assert.deepEqual(fts, ['test-bulletin']);
  } finally {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bulletin-doctor validates a configured temporary OpenClaw home', async () => {
  const { home, openclawDir, mailroomDir } = createOpenClawHome();
  fs.writeFileSync(
    path.join(mailroomDir, 'bulletin-config.json'),
    JSON.stringify({
      platform: 'discord',
      bulletinBoardChannel: '111111111111111111',
      escalationChannel: '222222222222222222',
      botToken: '${DISCORD_BOT_TOKEN}',
      gatewayToken: '${GATEWAY_AUTH_TOKEN}',
    }),
  );

  try {
    const { stdout } = await execFileAsync(process.execPath, [doctorPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawDir,
        DISCORD_BOT_TOKEN: 'test-discord-token',
        GATEWAY_AUTH_TOKEN: 'test-gateway-token',
      },
    });

    assert.match(stdout, /ok\s+bulletin config/);
    assert.match(stdout, /ok\s+agent groups/);
    assert.match(stdout, /All required checks passed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('configured secret vars prefer secrets.json over .env', async () => {
  const { home, openclawDir } = createOpenClawHome();
  fs.writeFileSync(path.join(openclawDir, '.env'), 'GATEWAY_AUTH_TOKEN=stale-env-token\n');
  fs.writeFileSync(
    path.join(openclawDir, 'secrets.json'),
    JSON.stringify({ GATEWAY_AUTH_TOKEN: 'rotated-secret-token' }),
  );

  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousGatewayAuthToken = process.env.GATEWAY_AUTH_TOKEN;
  try {
    process.env.OPENCLAW_HOME = openclawDir;
    delete process.env.GATEWAY_AUTH_TOKEN;
    const { loadConfiguredSecretVars, resolveConfigToken } = await import('../lib/config.ts');
    const configuredVars = loadConfiguredSecretVars();
    assert.equal(configuredVars.GATEWAY_AUTH_TOKEN, 'rotated-secret-token');
    assert.equal(
      resolveConfigToken('${GATEWAY_AUTH_TOKEN}', configuredVars),
      'rotated-secret-token',
    );
  } finally {
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    if (previousGatewayAuthToken === undefined) {
      delete process.env.GATEWAY_AUTH_TOKEN;
    } else {
      process.env.GATEWAY_AUTH_TOKEN = previousGatewayAuthToken;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('bulletin_post tool creates a bulletin and wakes resolved subscribers', async () => {
  const { home, openclawDir, mailroomDir } = createOpenClawHome();
  const previousOpenClawHome = process.env.OPENCLAW_HOME;
  const previousSetTimeout = globalThis.setTimeout;

  try {
    process.env.OPENCLAW_HOME = openclawDir;
    const pluginModule = await import(`../index.ts?test=${Date.now()}`);
    const plugin = pluginModule.default;
    const registeredTools = new Map();
    const subagentRuns = [];

    globalThis.setTimeout = () => ({ unref() {} });
    plugin.register({
      config: {},
      pluginConfig: {},
      runtime: {
        subagent: {
          run: async (params) => {
            subagentRuns.push(params);
            return { runId: `run-${subagentRuns.length}` };
          },
        },
        channel: {},
      },
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool(factory) {
        const tool = factory({ sessionKey: 'agent:dev' });
        registeredTools.set(tool.name, tool);
      },
      registerGatewayMethod() {},
      registerHttpRoute() {},
      registerHook() {},
      on() {},
    });
    globalThis.setTimeout = previousSetTimeout;

    const bulletinPost = registeredTools.get('bulletin_post');
    assert.ok(bulletinPost);

    const result = await bulletinPost.execute('call-1', {
      id: 'agent-created-bulletin',
      topic: 'Agent-created bulletin',
      body: 'Need structured input from engineering.',
      subscribers: ['engineering'],
      protocol: 'advisory',
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.bulletinId, 'agent-created-bulletin');
    assert.deepEqual(result.subscribers, ['dev', 'pm']);
    assert.equal(subagentRuns.length, 2);

    const rejected = await bulletinPost.execute('call-2', {
      topic: 'Bad subscriber',
      body: 'This should not create a bulletin.',
      subscribers: ['missing-agent'],
    });
    assert.equal(rejected.status, 'error');
    assert.match(rejected.message, /Unknown subscriber/);

    const db = new Database(path.join(mailroomDir, 'bulletins', 'bulletins.db'), { readonly: true });
    try {
      const bulletin = db
        .prepare('SELECT id, topic, protocol, created_by FROM bulletins WHERE id = ?')
        .get('agent-created-bulletin');
      assert.deepEqual(bulletin, {
        id: 'agent-created-bulletin',
        topic: 'Agent-created bulletin',
        protocol: 'advisory',
        created_by: 'dev',
      });
    } finally {
      db.close();
    }
  } finally {
    globalThis.setTimeout = previousSetTimeout;
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
