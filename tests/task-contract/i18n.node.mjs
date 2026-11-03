import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateTaskContract } from "../../skills/task-contract/scripts/validate-task-contract.mjs";

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(testsRoot, "..", "..", "skills", "task-contract", "scripts", "validate-task-contract.mjs");
const fixture = async (relative) => JSON.parse(await readFile(path.join(testsRoot, "fixtures", relative), "utf8"));

async function inLocale(locale, run) {
  const previous = process.env.AGENT_GOVERNANCE_LOCALE;
  process.env.AGENT_GOVERNANCE_LOCALE = locale;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else process.env.AGENT_GOVERNANCE_LOCALE = previous;
  }
}

async function receiptInput() {
  const input = await fixture("normal/project-development.json");
  input.request.authorizationEvidence[0].sourceReceiptId = "source-abcdefghijklmnop";
  input.report.authorizationProvenance[0].sourceReceiptId = "source-abcdefghijklmnop";
  return input;
}

for (const [locale, schemaFailure, receipt] of [
  ["en", "Task contract schema validation failed.", "A provenance receipt cannot authorize an action or satisfy an approval requirement."],
  ["ko", "작업 계약 schema 검증에 실패했다.", "출처 영수증은 행동을 허가하거나 승인 요구를 충족할 수 없다."],
]) {
  test(`validation errors are rendered in the ${locale} host locale`, async () => {
    await inLocale(locale, async () => {
      await assert.rejects(validateTaskContract({ schemaVersion: "1.0.0" }), { code: "INVALID_INPUT", message: schemaFailure });
      await assert.rejects(validateTaskContract(await receiptInput()), { code: "INVALID_INPUT", message: receipt });
    });
  });

  test(`the CLI writes its error sentence in the ${locale} host locale`, async () => {
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify(await receiptInput()), encoding: "utf8", windowsHide: true,
      env: { ...process.env, AGENT_GOVERNANCE_LOCALE: locale },
    });
    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error.code, "INVALID_INPUT");
    assert.equal(body.error.message, receipt);
  });
}
