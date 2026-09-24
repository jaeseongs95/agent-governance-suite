import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '../../../mcp-server/src/session-message-client.js';
import { RESOURCE_ADMISSION_FEATURE, RESOURCE_BROKER_OPERATION } from '../../../mcp-server/src/resource/broker-protocol.ts';

const source = fileURLToPath(new URL('../../../mcp-server/dist/session-message-broker.mjs', import.meta.url));
const contracts = fileURLToPath(new URL('../../../contracts/', import.meta.url));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b14-j-'));
  const install = path.join(root, 'install');
  const state = path.join(root, 'custom-message-state');
  const shared = path.join(root, 'shared-resource-state');
  const home = path.join(root, 'home');
  const broker = path.join(install, 'mcp-server', 'dist', 'session-message-broker.mjs');
  mkdirSync(path.dirname(broker), { recursive: true });
  cpSync(contracts, path.join(install, 'contracts'), { recursive: true });
  copyFileSync(source, broker);
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(root, 'local'), XDG_STATE_HOME: path.join(root, 'xdg'),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: shared, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state,
    AGENT_GOVERNANCE_DB_PATH: path.join(root, 'workflow.sqlite3'),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(root, 'continuity.sqlite3'),
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(root, 'trust.sqlite3') };
  return { root, state, shared, env, broker };
}

function launch(h) {
  const child = spawn(process.execPath, [h.broker, '--state-directory', h.state], {
    env: h.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.startupError = () => stderr;
  return child;
}

async function ready(h, child) {
  try { await waitForSessionMessageBrokerReady(h.state, child, 5000); }
  catch (error) { error.message += `\nBroker stderr: ${child.startupError()}`; throw error; }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'close');
  child.kill('SIGTERM');
  await exited;
}

test('B14-j custom message state never opens or writes the separate resource ledger', async () => {
  const h = fixture();
  const resource = path.join(h.shared, 'resource.sqlite3');
  mkdirSync(h.shared);
  writeFileSync(resource, 'existing resource bytes');
  const sender = { host: 'fixture', sessionId: 'sender' };
  const target = { host: 'fixture', sessionId: 'target' };
  let child;
  try {
    for (let restart = 0; restart < 2; restart += 1) {
      child = launch(h);
      await ready(h, child);
      const ping = await requestSessionMessageOnce('ping', {}, h.state);
      assert.equal(ping.capabilities.includes(RESOURCE_ADMISSION_FEATURE), false);
      await assert.rejects(requestSessionMessageOnce(RESOURCE_BROKER_OPERATION, {
        schemaVersion: '1.0.0', feature: RESOURCE_ADMISSION_FEATURE, requestId: 'request-1',
        operation: 'read-observation', args: { observationId: 'sha256:' + 'a'.repeat(64) },
      }, h.state), /Resource admission is unavailable/u);
      const sent = await requestSessionMessageOnce('send', {
        sender, target, body: `message-${restart}`,
      }, h.state);
      const claimed = await requestSessionMessageOnce('claim', { target }, h.state);
      assert.equal(claimed.messages[0].messageId, sent.messageId);
      assert.deepEqual(await requestSessionMessageOnce('acknowledge', {
        target, messageIds: [sent.messageId],
      }, h.state), { acknowledged: 1 });
      await stop(child);
      // Windows can terminate a child before its signal handler removes the lock; restart reclaims it.
      assert.equal(readFileSync(resource, 'utf8'), 'existing resource bytes');
      assert.deepEqual(readdirSync(h.shared), ['resource.sqlite3']);
    }
    assert.equal(existsSync(path.join(h.root, 'home', '.agent-governance-suite')), false);
    assert.equal(existsSync(path.join(h.root, 'workflow.sqlite3')), false);
  } finally {
    if (child) await stop(child);
    rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15000);

test('B14-j startup failure cleans the message lock and leaves the resource root absent', async () => {
  const h = fixture();
  mkdirSync(h.state);
  const obstacle = path.join(h.state, 'session-messages.sqlite3');
  mkdirSync(obstacle);
  let child;
  try {
    child = launch(h);
    await assert.rejects(waitForSessionMessageBrokerReady(h.state, child, 5000));
    assert.equal(child.exitCode, 1);
    assert.equal(existsSync(path.join(h.state, 'broker.lock')), false);
    assert.equal(existsSync(h.shared), false);
    rmSync(obstacle, { recursive: true });
    child = launch(h);
    await ready(h, child);
    assert.equal((await requestSessionMessageOnce('ping', {}, h.state)).protocolVersion, '1.0.0');
    await stop(child);
    assert.equal(existsSync(h.shared), false);
  } finally {
    if (child) await stop(child);
    rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 15000);
