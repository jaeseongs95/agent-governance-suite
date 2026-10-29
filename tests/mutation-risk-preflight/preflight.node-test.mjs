import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { canonicalLocator, evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "mutation-risk-preflight");
const fixturesRoot = path.join(testRoot, "fixtures");
const evaluationTime = "2026-09-09T00:00:00.000Z";

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixturesRoot, name, "intent.json"), "utf8"));
}

async function directoryDigest(directory) {
  const rows = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else rows.push(path.relative(directory, absolute).replaceAll("\\", "/") + ":" + createHash("sha256").update(await readFile(absolute)).digest("hex"));
    }
  }
  await walk(directory);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

test("정상·경계·실패 fixture가 실제 판정과 일치한다", async () => {
  const behavior = JSON.parse(await readFile(path.join(testRoot, "behavior-cases.json"), "utf8"));
  assert.deepEqual(new Set(behavior.cases.map((item) => item.class)), new Set(["normal", "boundary", "expected-failure"]));
  for (const item of behavior.cases) {
    const report = evaluatePreflight(await fixture(item.fixture), { now: evaluationTime });
    assert.equal(report.verdict, item.expectedVerdict, item.id);
  }
});

test("READY 보고서는 계약을 통과하고 실행 권한을 부여하지 않는다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const inputSchema = JSON.parse(await readFile(path.join(skillRoot, "contracts", "mutation-intent.v1.schema.json"), "utf8"));
  const schema = JSON.parse(await readFile(path.join(skillRoot, "contracts", "mutation-preflight-report.v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, formats: { "date-time": true } });
  assert.equal(ajv.compile(inputSchema)(intent), true);
  const validate = ajv.compile(schema);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.verdict, "READY");
  assert.equal("authorized" in report, false);
  assert.match(report.checks.find((item) => item.checkId === "authorization-match").message, /허용 범위/);
});

test("여러 대상이 같은 evidence를 공유해도 보고서와 receipt가 계약을 통과한다", async () => {
  const intent = await fixture("deploy");
  const shared = intent.currentStateEvidenceRefs[0];
  intent.targets.push({ ...intent.targets[0], locator: "service://payments-worker" });
  intent.currentStateEvidenceRefs.push({ ...shared, targetLocator: "service://payments-worker" });
  intent.scopeRef.includedTargets.push("service://payments-worker");
  intent.authorizationRef.allowedTargets.push("service://payments-worker");
  const approvalRef = {
    locator: "evidence://approval",
    digest: `sha256:${"7".repeat(64)}`,
    operationId: intent.operationId,
    actionClass: intent.actionClass,
    targetLocators: intent.targets.map((target) => target.locator),
    environments: [...new Set(intent.targets.map((target) => target.environment))],
    expiresAt: "2026-09-10T00:00:00.000Z",
  };
  intent.approvalEvidenceRefs = [approvalRef, { ...approvalRef }];
  intent.expectedBlastRadius.affectedTargets = intent.targets.length;
  intent.recoveryPlan.restoreProcedureRef = intent.recoveryPlan.backupRef;
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const schema = JSON.parse(await readFile(path.join(skillRoot, "contracts", "mutation-preflight-report.v1.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true, formats: { "date-time": true } }).compile(schema);
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.deepEqual(report.checks.find((item) => item.checkId === "current-state").evidenceRefs, [shared.locator]);
  assert.deepEqual(report.recovery.evidenceRefs, [intent.recoveryPlan.backupRef, intent.recoveryPlan.restoreTestEvidenceRef]);
  assert.equal(report.verdict, "READY", JSON.stringify(report.unresolved));
  assert.deepEqual(report.approval.evidenceRefs, [approvalRef.locator]);
  assert.equal(verifyReceipt({ report, intent, verificationTime: evaluationTime }).valid, true);
});

test("receipt는 대상 fingerprint, action과 만료 시각 변경을 거부한다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  assert.equal(verifyReceipt({ report, intent, verificationTime: "2026-09-09T00:01:00.000Z" }).valid, true);
  const changed = structuredClone(intent);
  changed.targets[0].expectedFingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  changed.currentStateEvidenceRefs[0].fingerprint = changed.targets[0].expectedFingerprint;
  const stale = verifyReceipt({ report, intent: changed, verificationTime: "2026-09-09T00:01:00.000Z" });
  assert.equal(stale.valid, false);
  assert.equal(stale.errorCode, "STALE_REVISION");
  const expired = verifyReceipt({ report, intent, verificationTime: "2026-09-09T00:16:00.000Z" });
  assert.equal(expired.valid, false);
  assert.equal(expired.errorCode, "STALE_REVISION");
});

test("receipt 유효기간 연장과 report 필드 변조를 거부한다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const extended = structuredClone(report);
  extended.validUntil = "2029-01-01T00:00:00.000Z";
  assert.equal(verifyReceipt({ report: extended, intent, verificationTime: "2027-01-01T00:00:00.000Z" }).valid, false);

  const malformed = structuredClone(report);
  malformed.unexpected = true;
  const invalid = verifyReceipt({ report: malformed, intent, verificationTime: "2026-09-09T00:01:00.000Z" });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.errorCode, "INVALID_INPUT");
});

test("approval·current-state·recovery·blast-radius evidence 교체를 거부한다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const mutations = [
    (changed) => { changed.approvalEvidenceRefs[0].locator = "evidence/approval-replaced.json"; },
    (changed) => { changed.currentStateEvidenceRefs[0].digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; },
    (changed) => { changed.recoveryPlan.restoreTestEvidenceRef = "evidence/restore-test-replaced.json"; },
    (changed) => { changed.expectedBlastRadius.description = "같은 수치지만 다른 영향 설명"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(intent);
    mutate(changed);
    const result = verifyReceipt({ report, intent: changed, verificationTime: "2026-09-09T00:01:00.000Z" });
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, "STALE_REVISION");
  }
});

test("supplied digest가 같아도 scope·authorization 실제 내용 변경을 거부한다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const scopeChanged = structuredClone(intent);
  scopeChanged.scopeRef.excludedTargets.push("D:/repo/unrelated");
  assert.equal(verifyReceipt({ report, intent: scopeChanged, verificationTime: "2026-09-09T00:01:00.000Z" }).valid, false);
  const authorizationChanged = structuredClone(intent);
  authorizationChanged.authorizationRef.allowedActions.push("publish");
  assert.equal(verifyReceipt({ report, intent: authorizationChanged, verificationTime: "2026-09-09T00:01:00.000Z" }).valid, false);
});

test("intent와 report는 verifyReceipt에서 JSON Schema로 엄격 검증된다", async () => {
  const intent = await fixture("local-delete");
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const malformedIntent = structuredClone(intent);
  malformedIntent.extra = true;
  const result = verifyReceipt({ report, intent: malformedIntent, verificationTime: "2026-09-09T00:01:00.000Z" });
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, "INVALID_INPUT");
});

test("계약 위반 intent도 schema-valid BLOCKED 보고서로 정규화한다", async () => {
  const intent = await fixture("local-delete");
  intent.operationId = 42;
  intent.targets = { locator: "D:/repo/file.txt" };
  intent.expectedBlastRadius.unexpected = true;
  const report = evaluatePreflight(intent, { now: evaluationTime });
  const schema = JSON.parse(await readFile(path.join(skillRoot, "contracts", "mutation-preflight-report.v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, formats: { "date-time": true } });
  const validate = ajv.compile(schema);
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
});

test("Windows drive·UNC root와 변수·glob target은 안전하지 않다", async () => {
  assert.equal(canonicalLocator("D:\\Repo\\file.txt"), "d:/Repo/file.txt");
  for (const locator of ["C:\\", "\\\\server\\share", "%USERPROFILE%\\x", "D:\\repo\\*", "~"]) {
    const intent = await fixture("local-delete");
    intent.targets[0].locator = locator;
    intent.scopeRef.includedTargets = [locator];
    intent.authorizationRef.allowedTargets = [locator];
    intent.approvalEvidenceRefs[0].targetLocators = [locator];
    intent.currentStateEvidenceRefs[0].targetLocator = locator;
    assert.equal(evaluatePreflight(intent, { now: evaluationTime }).verdict, "BLOCKED", locator);
  }
});

test("JSON CLI는 MCP와 suite import 없이 직접 실행되고 아무 파일도 바꾸지 않는다", async () => {
  const inputPath = path.join(fixturesRoot, "local-delete", "intent.json");
  const before = await directoryDigest(fixturesRoot);
  const result = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "evaluate-preflight.mjs"), "--input", inputPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verdict, "READY");
  assert.equal(await directoryDigest(fixturesRoot), before);
  const source = [
    await readFile(path.join(skillRoot, "scripts", "evaluate-preflight.mjs"), "utf8"),
    await readFile(path.join(skillRoot, "scripts", "verify-preflight-receipt.mjs"), "utf8"),
    await readFile(path.join(skillRoot, "scripts", "schema-validation.mjs"), "utf8")
  ].join("\n");
  assert.doesNotMatch(source, /agent-governance-suite|mcp-server|skills\\registry/);
  assert.doesNotMatch(source, /node:child_process|\bwriteFile\b|\bunlink\b|\brename\b|\brmSync\b|\bfetch\s*\(/);
});

test("vendored TaskEnvelope snapshot checksum이 lock과 일치한다", async () => {
  const lock = JSON.parse(await readFile(path.join(skillRoot, "contracts", "upstream", "lock.json"), "utf8"));
  const item = lock.upstreams[0];
  const snapshot = await readFile(path.join(skillRoot, item.snapshotPath));
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), item.sha256);
  const parsed = JSON.parse(snapshot);
  assert.equal(parsed.$id, item.schemaId);
  assert.equal(item.supplierVersion, "0.2.0");
});

test("integration descriptor는 precondition gate이고 독립 감사로 가장하지 않는다", async () => {
  const descriptor = JSON.parse(await readFile(path.join(skillRoot, "integration", "skill-descriptor.json"), "utf8")).providers[0];
  assert.deepEqual(descriptor.gate, {
    kind: "precondition",
    policy: "conditional",
    validator: "contracts/mutation-preflight-report.v1.schema.json"
  });
  assert.ok(!descriptor.capabilities.includes("independent-audit"));
  assert.equal(descriptor.phaseOrder, 45);
});

// 실제 CLI에 같은 바이트를 보내며 750ms 간격으로 UTF-8 문자 내부를 나눈다.
async function runInputCli(script, bytes, splitAt, inputPath, preload) {
  const marker = "AGS_TEST_FIRST_STDIN_CHUNK_CONSUMED\n";
  // 소비 루프에 원래 조각을 그대로 넘긴 뒤 재개될 때 관측한다. 디코딩은 제품 코드가 한다.
  const observer = `const original = process.stdin[Symbol.asyncIterator].bind(process.stdin);
    process.stdin[Symbol.asyncIterator] = async function* () {
      let first = true;
      for await (const chunk of original()) {
        yield chunk;
        if (first) { first = false; process.stderr.write(${JSON.stringify(marker)}); }
      }
    };`;
  const observeArgs = splitAt === undefined ? [] : ["--import", `data:text/javascript,${encodeURIComponent(observer)}`];
  const preloadArgs = preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const child = spawn(process.execPath, [...preloadArgs, ...observeArgs, script, ...(inputPath ? ["--input", inputPath] : [])], {
    stdio: ["pipe", "pipe", "pipe"], timeout: 10_000,
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  let notifyFirst;
  const firstConsumed = new Promise((resolve) => { notifyFirst = resolve; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
    if (stderr.includes(marker)) notifyFirst();
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  // 조기 종료에 따른 pipe 오류도 시험 실패로 드러낸다.
  let inputError;
  child.stdin.on("error", (error) => { inputError = error; });
  try {
    if (inputPath) child.stdin.end();
    else if (splitAt === undefined) child.stdin.end(bytes);
    else {
      child.stdin.write(bytes.subarray(0, splitAt));
      await Promise.race([firstConsumed, closed]);
      assert.ok(stderr.includes(marker), "나머지를 보내기 전에 첫 stdin 조각 소비를 관측해야 한다");
      await delay(750);
      assert.equal(stdout, "", "EOF 전에는 판정이 출력되면 안 된다");
      child.stdin.end(bytes.subarray(splitAt));
    }
    const result = await closed;
    assert.equal(inputError, undefined);
    assert.equal(result.signal, null, stderr);
    return { ...result, stdout, stderr: stderr.replaceAll(marker, "") };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
}

for (const distribution of ["skills", "claude-plugin/skills"]) {
  for (const command of ["evaluate-preflight", "verify-preflight-receipt"]) {
    test(`${distribution}/${command}: UTF-8 분할 stdin과 파일 입력이 동등하다`, { timeout: 30_000 }, async (t) => {
      const script = path.resolve(testRoot, "../..", distribution, "mutation-risk-preflight/scripts", `${command}.mjs`);
      const directory = await mkdtemp(path.join(tmpdir(), "ags-preflight-stdin-"));
      try {
        const intent = await fixture("local-delete");
        intent.operationId = "리-한국어-입력";
        intent.approvalEvidenceRefs[0].operationId = intent.operationId;
        const verifying = command === "verify-preflight-receipt";
        const input = verifying
          ? { report: evaluatePreflight(intent, { now: evaluationTime }), intent, verificationTime: evaluationTime }
          : intent;
        const korean = Buffer.from(JSON.stringify(input), "utf8");
        const ascii = Buffer.from(JSON.stringify(input).replace(/[^\x00-\x7f]/g,
          (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`), "ascii");
        const normalize = (result) => {
          assert.equal(result.code, 0, result.stderr || result.stdout);
          assert.equal(result.stderr, "");
          const output = JSON.parse(result.stdout);
          if (verifying) assert.equal(output.valid, true);
          else {
            assert.equal(output.verdict, "READY");
            assert.equal(output.operationId, intent.operationId);
            assert.equal(Date.parse(output.validUntil) - Date.parse(output.observedAt), 15 * 60_000);
            delete output.observedAt;
            delete output.validUntil;
          }
          return output;
        };
        const file = path.join(directory, "input.json");
        await writeFile(file, korean);
        const expected = normalize(await runInputCli(script, korean, undefined, file));
        assert.deepEqual(normalize(await runInputCli(script, ascii)), expected, "ASCII stdin");
        assert.deepEqual(normalize(await runInputCli(script, ascii, 1)), expected, "ASCII 분할 stdin");
        assert.deepEqual(normalize(await runInputCli(script, korean)), expected, "한국어 stdin");
        const first = korean.indexOf(Buffer.from("리", "utf8"));
        assert.ok(first >= 0);
        for (const offset of [1, 2]) {
          await t.test(`3바이트 문자 내부 ${offset}바이트 경계`, async () => {
            assert.deepEqual(normalize(await runInputCli(script, korean, first + offset)), expected);
          });
        }
        if (verifying) {
          const stale = structuredClone(input);
          stale.intent.expectedBlastRadius.description += " 변경";
          const staleBytes = Buffer.from(JSON.stringify(stale));
          await writeFile(file, staleBytes);
          const reference = await runInputCli(script, staleBytes, undefined, file);
          assert.equal(reference.code, 2);
          assert.equal(JSON.parse(reference.stdout).errorCode, "STALE_REVISION");
          const result = await runInputCli(script, staleBytes, first + 1);
          assert.equal(result.code, reference.code);
          assert.deepEqual(JSON.parse(result.stdout), JSON.parse(reference.stdout));
        }
        const incomplete = await runInputCli(script, Buffer.concat([Buffer.from('{"operationId":"'), Buffer.from([0xed, 0x95])]));
        if (verifying) {
          assert.equal(incomplete.code, 1);
          assert.match(incomplete.stderr, /SyntaxError/);
        } else {
          assert.equal(incomplete.code, 2);
          assert.equal(JSON.parse(incomplete.stdout).verdict, "BLOCKED");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

for (const distribution of ["skills", "claude-plugin/skills"]) {
  for (const command of ["evaluate-preflight", "verify-preflight-receipt"]) {
    test(`${distribution}/${command}: UTF-8 추가 경계와 EOF 대기를 보존한다`, { timeout: 30_000 }, async (t) => {
      const script = path.resolve(testRoot, "../..", distribution, "mutation-risk-preflight/scripts", `${command}.mjs`);
      const directory = await mkdtemp(path.join(tmpdir(), "ags-preflight-extra-"));
      try {
        const intent = await fixture("local-delete");
        intent.operationId = "¢-😀-�-정상문자";
        intent.approvalEvidenceRefs[0].operationId = intent.operationId;
        const verifying = command === "verify-preflight-receipt";
        const input = verifying
          ? { report: evaluatePreflight(intent, { now: evaluationTime }), intent, verificationTime: evaluationTime }
          : intent;
        const bytes = Buffer.from(JSON.stringify(input));
        const file = path.join(directory, "input.json");
        await writeFile(file, bytes);
        const normalize = (result) => {
          assert.equal(result.code, 0, result.stderr || result.stdout);
          assert.equal(result.stderr, "");
          const output = JSON.parse(result.stdout);
          if (verifying) assert.equal(output.valid, true);
          else {
            assert.equal(output.verdict, "READY");
            assert.equal(output.operationId, intent.operationId);
            assert.equal((output.operationId.match(/�/g) ?? []).length, 1, "원래 정상 U+FFFD는 하나만 유지해야 한다");
            assert.equal(Date.parse(output.validUntil) - Date.parse(output.observedAt), 15 * 60_000);
            delete output.observedAt;
            delete output.validUntil;
          }
          return output;
        };
        const expected = normalize(await runInputCli(script, bytes, undefined, file));
        await t.test("정상 U+FFFD 포함 실제 stdin", async () => {
          assert.deepEqual(normalize(await runInputCli(script, bytes)), expected);
        });
        for (const character of ["¢", "😀"]) {
          const encoded = Buffer.from(character);
          const at = bytes.indexOf(encoded);
          assert.ok(at >= 0);
          for (let offset = 1; offset < encoded.length; offset++) {
            await t.test(`실제 파이프 ${encoded.length}바이트 문자 내부 ${offset}바이트 경계`, async () => {
              assert.deepEqual(normalize(await runInputCli(script, bytes, at + offset)), expected);
            });
          }
        }
        await t.test("제어된 Readable의 한 바이트 조각", async () => {
          // 단위 경계 주입: OS 파이프 수신 청크 관측으로 주장하지 않는다.
          const preload = `import { Readable } from "node:stream";
            const bytes = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");
            const stream = Readable.from((async function* () {
              for (const byte of bytes) {
                yield Buffer.from([byte]);
                await new Promise(setImmediate);
              }
            })(), { objectMode: false });
            Object.defineProperty(process, "stdin", { value: stream });`;
          assert.deepEqual(normalize(await runInputCli(script, Buffer.alloc(0), undefined, undefined, preload)), expected);
        });
        await t.test("실제 파이프 ASCII JSON escape 내부", async () => {
          const ascii = Buffer.from(JSON.stringify(input).replace(/[^\x00-\x7f]/g,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`), "ascii");
          const at = ascii.indexOf(Buffer.from("\\u00a2"));
          assert.ok(at >= 0);
          assert.deepEqual(normalize(await runInputCli(script, ascii, at + 3)), expected);
        });
        await t.test("실제 파이프 완전 JSON의 EOF 전 판정 없음", async () => {
          assert.deepEqual(normalize(await runInputCli(script, bytes, bytes.length)), expected);
        });
        if (verifying) {
          await t.test("실제 만료된 영수증의 파일과 stdin 거부", async () => {
            const expired = Buffer.from(JSON.stringify({ ...input, verificationTime: input.report.validUntil }));
            await writeFile(file, expired);
            const reference = await runInputCli(script, expired, undefined, file);
            const result = await runInputCli(script, expired);
            assert.equal(reference.code, 2);
            assert.equal(result.code, reference.code);
            assert.equal(JSON.parse(result.stdout).errorCode, "STALE_REVISION");
            assert.deepEqual(JSON.parse(result.stdout), JSON.parse(reference.stdout));
          });
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
