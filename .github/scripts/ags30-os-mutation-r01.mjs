// Draft helper only. Importing this module never imports or executes the product.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const production = 'mcp-server/src/broker-process-lock.ts';
const once = (text, anchor, replacement) => {
  const index = text.indexOf(anchor);
  assert(index >= 0 && text.indexOf(anchor, index + 1) < 0, 'Mutation anchor is missing or ambiguous');
  return text.slice(0, index) + replacement + text.slice(index + anchor.length);
};

export function mutateLock(text, id) {
  if (id === 'OS-001') return once(text,
    '    mkdirSync(path.join(stage, owner), { mode: 0o700 });',
    '    mkdirSync(lockPath, { mode: 0o700 });\n    mkdirSync(path.join(stage, owner), { mode: 0o700 });');
  const imported = once(text, 'readdirSync, renameSync, rmdirSync } from "node:fs";',
    'readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";');
  if (id === 'OS-002') return once(imported,
    '    if (["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(code(error) ?? "")) return unavailable("CHANGED", error);',
    '    if (code(error) === "ENOENT") { rmSync(lockPath, { recursive: true, force: true }); return true; }\n' +
    '    if (["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(code(error) ?? "")) return unavailable("CHANGED", error);');
  assert.equal(id, 'OS-003', 'Unknown mutation case');
  return once(imported,
    '  catch (error) { if (code(error) === "ENOENT") return; throw error; }',
    '  catch (error) { if (code(error) === "ENOENT") { rmSync(lock.path, { recursive: true, force: true }); return; } throw error; }');
}

export function assertionWitness(id, report, receipt) {
  assert.equal(receipt.status, 'FAIL', 'Red must be an ordinary process failure');
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.signal, null);
  const cases = report.testResults.flatMap(suite => suite.assertionResults ?? []);
  const failed = cases.filter(item => item.status === 'failed');
  assert.equal(failed.length, 1, 'Red must fail exactly the selected test');
  assert(failed[0].fullName.includes(id + ':'), 'Wrong red test failed');
  const message = failed[0].failureMessages.join('\n').replace(new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g'), '');
  assert(!/deadline|timed out|Cannot find module|Failed to (?:load|resolve)|SyntaxError/i.test(message),
    'Scheduling, import and runner failures are not red evidence');
  const observed = {
    'OS-001': [/promise resolved[\s\S]*instead of rejecting/i, 'instead of rejecting'],
    'OS-002': [/expected[\s\S]*acquired[\s\S]*contended/i, 'contended'],
    'OS-003': [/ENOENT[\s\S]*scandir[\s\S]*broker\.lock/i, 'ENOENT'],
  }[id];
  assert(observed && observed[0].test(message), 'The intended ownership oracle did not fail');
  assert((receipt.stdout + '\n' + receipt.stderr).includes(observed[1]), 'Assertion witness absent from receipt logs');
  return observed[1];
}

export async function collectOSMutations({ sourceRoot, planFile, outputRoot, deadline, wholeSourcePortableId }) {
  // Called only after official generation, never while constructing the source candidate.
  const load = rel => import(pathToFileURL(path.join(sourceRoot, rel)).href);
  const { captureSnapshot, validatePlan, validateProof } = await load('runtime/engineering-practices/core.mjs');
  const { runCommand } = await load('runtime/engineering-practices/runner.mjs');
  const { hashJson, hashBytes } = await load('runtime/engineering-practices/io.mjs');
  const baselinePlan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  const plan = structuredClone(baselinePlan);
  plan.scopeFiles = [...plan.scopeFiles, 'mcp-server/src/process-identity.ts'];
  const vitestCli = await fs.realpath(path.join(sourceRoot, 'node_modules/vitest/vitest.mjs'));
  plan.runner = 'Existing Vitest via exact Node/realpath Vitest CLI argv; engineering runCommand receipts';
  const environmentNote = `Node ${process.version}; ${process.platform}/${process.arch}; same pinned pnpm/dependency tree; ` +
    'red has only the declared production mutation, unchanged original test scope plus its unchanged process-identity dependency and copied package.json/vitest.config.mjs. ' +
    'Full non-generated source is bound separately by the outer collector. Receipt logs are UTF-8 diagnostic strings, not raw-byte archives.';
  plan.environment = environmentNote;
  plan.exclusions = [
    'Only the original three OS races and their declared dependency-complete snapshot are in this proof.',
    'Package/config/dependencies outside the snapshot require the outer full-source and environment binding.',
    'Permanent empty state, crash-stage cleanup, PID reuse, caller stderr, readiness integration remain outside these three cases.',
    'The inherited contractDigest identifies source preparation and supplies no execution authorization.',
    'Consistency is not host attestation, independent audit or whole acceptance.'
  ];
  for (const item of plan.cases) item.sensitivityReason = item.sensitivityReason.split(' 현재 source-preparation 범위')[0] +
    ' Actual red must be the intended oracle failure; scheduler/import/runner errors do not demonstrate sensitivity.';
  for (const item of plan.cases) item.argv = [process.execPath, vitestCli, 'run',
    'tests/session-messaging/broker-process-lock.os.test.ts', '-t', item.id + ':',
    '--reporter=default', '--reporter=json', `--outputFile=../${item.id}.vitest.json`];
  await fs.mkdir(outputRoot);
  const write = async (relative, value) => {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    await fs.writeFile(path.join(outputRoot, relative), bytes, { flag: 'wx' });
    return { path: relative, digest: hashBytes(bytes) };
  };
  await write('runtime-plan.json', plan);
  await write('runtime-plan-result.json', validatePlan(plan));
  const seedBytes = await fs.readFile(planFile);
  await write('runtime-plan-binding.json', { seedPlanDigest: hashBytes(seedBytes), runtimePlanDigest: hashJson(plan),
    wholeSourcePortableId, argvFrozenBeforeExecution: true, priorSourcePlanExecutionNotInherited: true });
  const candidate = captureSnapshot(sourceRoot, plan.scopeFiles);
  for (const relative of plan.scopeFiles) {
    const destination = path.join(outputRoot, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, relative), destination);
  }
  assert.equal(captureSnapshot(outputRoot, plan.scopeFiles).digest, candidate.digest);
  const empty = { path: '', digest: hashBytes('') };
  const proof = { schemaVersion: '1.0.0', kind: 'engineering-test-proof', planDigest: hashJson(plan), candidate, proofs: [] };
  const observations = [];
  const scratch = path.join(path.dirname(sourceRoot), 'owned-mutations');
  await fs.mkdir(scratch);
  const original = await fs.readFile(path.join(sourceRoot, production), 'utf8');
  for (const item of plan.cases) {
    const observation = { caseId: item.id, status: 'NOT_RUN' };
    observations.push(observation);
    const entry = { caseId: item.id, status: 'NOT_RUN', red: { ...empty }, green: { ...empty },
      mutationPaths: [], assertionWitness: '', reason: 'No valid red/green evidence collected.' };
    proof.proofs.push(entry);
    let failureStage = 'PREPARATION';
    try {
      assert(deadline - Date.now() >= 95_000, 'Insufficient bounded budget for one red/green pair');
      const caseRoot = path.join(scratch, item.id);
      const redRoot = path.join(caseRoot, 'source');
      await fs.mkdir(caseRoot);
      await fs.mkdir(redRoot);
      for (const relative of [...plan.scopeFiles, 'package.json', 'vitest.config.mjs']) {
        const destination = path.join(redRoot, relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(sourceRoot, relative), destination);
      }
      await fs.symlink(path.join(sourceRoot, 'node_modules'), path.join(redRoot, 'node_modules'), 'junction');
      await fs.writeFile(path.join(redRoot, production), mutateLock(original, item.id), 'utf8');
      const redSnapshot = captureSnapshot(redRoot, plan.scopeFiles);
      failureStage = 'RED_EXECUTION';
      const red = runCommand(redRoot, redSnapshot, item.argv, { timeoutMs: 45_000, environmentNote });
      const redRef = await write(`${item.id}.red.receipt.json`, red);
      observation.redStatus = red.status;
      // Green is recorded even when red did not hit the intended oracle; it cannot repair an invalid red.
      failureStage = 'GREEN_EXECUTION';
      const green = runCommand(sourceRoot, candidate, item.argv, { timeoutMs: 45_000, environmentNote });
      const greenRef = await write(`${item.id}.green.receipt.json`, green);
      observation.greenStatus = green.status;
      failureStage = 'REPORT_READ';
      const redReportBytes = await fs.readFile(path.join(caseRoot, `${item.id}.vitest.json`));
      const greenReportBytes = await fs.readFile(path.join(path.dirname(sourceRoot), `${item.id}.vitest.json`));
      await fs.writeFile(path.join(outputRoot, `${item.id}.red.vitest.json`), redReportBytes, { flag: 'wx' });
      await fs.writeFile(path.join(outputRoot, `${item.id}.green.vitest.json`), greenReportBytes, { flag: 'wx' });
      const redReport = JSON.parse(redReportBytes.toString('utf8'));
      const greenReport = JSON.parse(greenReportBytes.toString('utf8'));
      failureStage = 'RED_WITNESS';
      const witness = assertionWitness(item.id, redReport, red);
      failureStage = 'GREEN_WITNESS';
      assert.equal(green.status, 'PASS');
      assert.equal(greenReport.numFailedTests, 0);
      assert.equal(greenReport.numFailedTestSuites, 0);
      assert.equal(greenReport.numPassedTests, 1);
      const greenCases = greenReport.testResults.flatMap(suite => suite.assertionResults ?? []);
      const passed = greenCases.filter(value => value.status === 'passed');
      assert.equal(passed.length, 1);
      assert(passed[0].fullName.includes(item.id + ':'));
      Object.assign(entry, { status: 'DEMONSTRATED', red: redRef, green: greenRef, mutationPaths: [production],
        assertionWitness: witness, reason: 'Original test candidate and process-identity dependency unchanged; intended oracle failed under the exact isolated production mutation, then same argv passed on original production bytes.' });
      observation.status = 'DEMONSTRATED';
      observation.counts = { red: { total: redReport.numTotalTests, failed: redReport.numFailedTests, pending: redReport.numPendingTests },
        green: { total: greenReport.numTotalTests, passed: greenReport.numPassedTests, pending: greenReport.numPendingTests } };
    } catch (error) {
      observation.status = 'INVALID_OR_INCOMPLETE_EVIDENCE';
      observation.failureStage = failureStage;
      observation.error = error.message;
      entry.reason = `No admissible proof: ${error.message}. Any actual receipts remain separate observations; no red evidence is inferred.`;
    }
  }
  await write('observations.json', observations);
  await write('engineering-test-proof.json', proof);
  const result = validateProof(outputRoot, plan, proof);
  await write('engineering-test-result.json', result);
  return { verdict: result.verdict, scopeDigest: candidate.digest, planDigest: proof.planDigest,
    cases: observations, fullSourceAcceptance: 'NOT_CLAIMED', proofLimit: 'Unsigned consistency check; oracle causality still requires independent review.' };
}
