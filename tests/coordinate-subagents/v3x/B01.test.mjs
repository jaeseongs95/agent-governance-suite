import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { assertResourceAuthorityIdentity, resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';

test('B01 workflow locations in one realm use one independent resource database', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-resource-config-'));
  try {
    const sharedRoot = path.join(root, 'shared');
    const home = path.join(root, 'home');
    const workspaces = ['first', 'second'];
    const configs = workspaces.map(workspace => {
      const workflowPath = path.join(root, workspace, 'workflows.sqlite3');
      const environment = { AGENT_GOVERNANCE_SHARED_STATE_DIR: sharedRoot, AGENT_GOVERNANCE_DB_PATH: workflowPath };
      return resolveResourceAuthorityConfig(environment, process.platform, home, path.join(root, workspace));
    });
    assert.equal(configs[0].databasePath, path.join(sharedRoot, 'resource.sqlite3'));
    assert.deepEqual(configs[1], configs[0]);
    assert.equal(configs[0].ownerMode, 'single-broker');
    assert.equal(configs[0].authorityId, 'ags-resource-authority-v1');
    assert.equal(path.isAbsolute(configs[0].databasePath), true);
    assert.equal(existsSync(sharedRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B01 realm mismatch and database aliases fail without touching a workflow database', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-resource-isolation-'));
  try {
    const sharedRoot = path.join(root, 'shared');
    const workflowPath = path.join(root, 'workflow.sqlite3');
    writeFileSync(workflowPath, 'user-owned');
    const environment = { AGENT_GOVERNANCE_SHARED_STATE_DIR: sharedRoot, AGENT_GOVERNANCE_DB_PATH: workflowPath };
    const config = resolveResourceAuthorityConfig(environment, process.platform, root);
    const other = resolveResourceAuthorityConfig({ ...environment, AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(root, 'other') }, process.platform, root);
    assert.notEqual(config.realmId, other.realmId);
    assert.throws(() => assertResourceAuthorityIdentity(config, other), /mismatch/u);
    assert.doesNotThrow(() => assertResourceAuthorityIdentity(config, { realmId: config.realmId, authorityId: config.authorityId }));
    assert.throws(() => resolveResourceAuthorityConfig({ ...environment, AGENT_GOVERNANCE_DB_PATH: config.databasePath }, process.platform, root), /different files/u);
    assert.throws(() => resolveResourceAuthorityConfig({ ...environment, AGENT_GOVERNANCE_CONTINUITY_DB_PATH: config.databasePath }, process.platform, root), /different files/u);
    assert.throws(() => resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: 'relative' }, process.platform, root), /absolute path/u);
    assert.equal(readFileSync(workflowPath, 'utf8'), 'user-owned');
    assert.equal(existsSync(sharedRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
