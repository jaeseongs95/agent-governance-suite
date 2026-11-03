import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveInstructionFiles } from "../../skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "instruction-scope-resolver", "scripts", "resolve-instruction-files.mjs");

async function inLocale(locale, run) {
  const previous = process.env.AGENT_GOVERNANCE_LOCALE;
  process.env.AGENT_GOVERNANCE_LOCALE = locale;
  try { return await run(); } finally {
    if (previous === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else process.env.AGENT_GOVERNANCE_LOCALE = previous;
  }
}

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "instruction-scope-i18n-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "root\n");
  return root;
}

const request = (root, target, mayNotExist = false) => ({
  schemaVersion: "1.0.0",
  workspaceRoot: root,
  instructionRoots: [{ path: root, precedence: 10, authorized: true }, { path: path.join(root, "unused"), precedence: 20, authorized: false }],
  targets: [{ path: target, mayNotExist }],
  externalPolicyRefs: [],
});

for (const [locale, outside, finding, skipped] of [
  ["en", "Target path is outside workspaceRoot.", "Target does not exist; future nested instructions cannot be observed: ", "Skipped unauthorized instruction root: "],
  ["ko", "대상 경로가 workspaceRoot 밖에 있다.", "대상이 없어서, 앞으로 생길 하위 지침은 관찰할 수 없다: ", "승인되지 않은 지침 root를 건너뛰었다: "],
]) {
  test(`errors and findings are rendered in the ${locale} host locale`, async (t) => {
    const root = await workspace(t);
    await inLocale(locale, async () => {
      await assert.rejects(resolveInstructionFiles(request(root, "../outside")), { code: "INVALID_INPUT", message: outside });
      const planned = await resolveInstructionFiles(request(root, "src/new/file.ts", true));
      assert.ok(planned.findings.includes(`${finding}src/new/file.ts`), JSON.stringify(planned.findings));
      assert.ok(planned.findings.includes(`${skipped}${path.join(root, "unused")}`), JSON.stringify(planned.findings));
    });
  });

  test(`the CLI writes its error sentence in the ${locale} host locale`, () => {
    const result = spawnSync(process.execPath, [script], {
      input: "", encoding: "utf8", windowsHide: true, env: { ...process.env, AGENT_GOVERNANCE_LOCALE: locale },
    });
    assert.equal(result.status, 1);
    const body = JSON.parse(result.stdout);
    assert.equal(body.error.code, "INVALID_INPUT");
    assert.equal(body.error.message, locale === "en" ? "Expected JSON on stdin or --input <file>." : "stdin의 JSON 또는 --input <file>이 필요하다.");
  });
}
