import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { profileWorkspace } from "../../skills/workspace-convention-profiler/scripts/profile-workspace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const text = "리¢😀�";
const readers = [
  ["acceptance-evidence-validator", "readJsonArgument"],
  ["blocker-diagnostician", "readJsonArgument"],
  ["evaluation-validity-auditor", "readJsonInput"],
  ["iteration-frame-auditor", "readJsonArgument"],
  ["recovery-strategy-selector", "readJsonInput"],
];
const profileRequest = () => ({
  schemaVersion: "1.0.0",
  workspaceRoot: path.join(root, "tests/workspace-convention-profiler/fixtures/python"),
  taskObjective: text, targetPaths: ["src"], resolvedInstructionRefs: [], knownConstraints: [],
  evidenceLimits: { maxFiles: 100, maxBytesPerFile: 100000, excludedPatterns: [] },
});

async function boundary(kind, distribution, directory) {
  const scripts = path.join(root, distribution);
  const reader = readers.find(([name]) => name === kind);
  if (reader) {
    const module = pathToFileURL(path.join(scripts, kind, "scripts/io.mjs")).href;
    // 실제 수신 함수를 사용하고 반환 객체를 전부 관측한다. 업무 판정 함수로 우회하지 않는다.
    const source = `import { ${reader[1]} as read } from ${JSON.stringify(module)}; console.log(JSON.stringify(await read(process.argv.slice(1))));`;
    return { argv: ["--input-type=module", "-e", source, "--"], input: { text, nested: [text] }, check: value => assert.deepEqual(value, { text, nested: [text] }) };
  }
  if (kind === "instruction-scope-resolver") {
    await mkdir(path.join(directory, text));
    await writeFile(path.join(directory, "AGENTS.md"), "읽기 전용 시험 규칙\n");
    return {
      argv: [path.join(scripts, kind, "scripts/resolve-instruction-files.mjs")],
      input: { schemaVersion: "1.0.0", workspaceRoot: directory, instructionRoots: [{ path: directory, precedence: 1, authorized: true }], targets: [{ path: text, mayNotExist: false }], externalPolicyRefs: [] },
      check: value => { assert.equal(value.ok, true); assert.equal(value.output.targets[0].requestedPath, text); },
    };
  }
  if (kind === "task-contract") {
    const input = JSON.parse(await readFile(path.join(root, "tests/task-contract/fixtures/normal/simple-read.json"), "utf8"));
    input.report.taskEnvelope.objective = text;
    return { argv: [path.join(scripts, kind, "scripts/validate-task-contract.mjs")], input,
      check: value => { assert.equal(value.ok, true); assert.equal(value.output.taskEnvelope.objective, text); } };
  }
  if (kind === "profile-workspace") {
    return { argv: [path.join(scripts, "workspace-convention-profiler/scripts/profile-workspace.mjs")], input: profileRequest(),
      check: value => { assert.equal(value.verdict, "PASS"); assert.match(value.profileFingerprint, /^sha256:[a-f0-9]{64}$/); } };
  }
  const profile = await profileWorkspace(profileRequest());
  assert.equal(profile.verdict, "PASS");
  assert.ok(profile.evidenceIndex.length);
  const original = profile.evidenceIndex[0].locator;
  // 정상 참조 양쪽은 같은 한글 locator를 갖는다. 한 출현만 손상되면 실제 참조 검사가 실패한다.
  const rewrite = value => {
    if (typeof value === "string") return value === original || value.startsWith(`${original}#`) ? text + value.slice(original.length) : value;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
    return value;
  };
  return { argv: [path.join(scripts, "workspace-convention-profiler/scripts/validate-profile.mjs")], input: rewrite(profile),
    check: value => assert.deepEqual(value, { valid: true, errors: [] }) };
}

async function runInputCli(argv, bytes, splitAt, inputPath, preload) {
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
  const child = spawn(process.execPath, [...preloadArgs, ...observeArgs, ...argv, ...(inputPath ? ["--input", inputPath] : [])], {
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
  for (const kind of [...readers.map(([name]) => name), "instruction-scope-resolver", "task-contract", "profile-workspace", "validate-profile"]) {
    test(`${distribution}/${kind}: 형제 UTF-8 수신 경계`, { timeout: 45_000 }, async t => {
      const directory = await mkdtemp(path.join(tmpdir(), "ags-sibling-stdin-"));
      try {
        const item = await boundary(kind, distribution, directory);
        const bytes = Buffer.from(JSON.stringify(item.input));
        const file = path.join(directory, "input.json");
        await writeFile(file, bytes);
        const normalize = result => {
          assert.equal(result.code, 0, result.stderr || result.stdout);
          assert.equal(result.stderr, "");
          const value = JSON.parse(result.stdout);
          item.check(value);
          if (kind === "profile-workspace") delete value.observedAt;
          return value;
        };
        const expected = normalize(await runInputCli(item.argv, bytes, undefined, file));
        const ascii = Buffer.from(JSON.stringify(item.input).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
        assert.deepEqual(normalize(await runInputCli(item.argv, ascii)), expected, "ASCII 이스케이프 입력");
        assert.deepEqual(normalize(await runInputCli(item.argv, bytes)), expected, "완전한 UTF-8 입력");
        const first = bytes.indexOf(Buffer.from(text));
        assert.ok(first >= 0);
        for (const offset of [1, 2]) {
          await t.test(`한글 내부 ${offset}바이트 경계와 EOF 대기`, async () => {
            assert.deepEqual(normalize(await runInputCli(item.argv, bytes, first + offset)), expected);
          });
        }
        // 시험용 공급기이며 운영체제의 실제 한 바이트 수신을 주장하지 않는다.
        const preload = `import { Readable } from "node:stream";
          const chunks = Readable.from((async function* () { for (const byte of Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64")) { yield Buffer.from([byte]); await new Promise(setImmediate); } })(), { objectMode: false });
          Object.defineProperty(process, "stdin", { value: chunks });`;
        await t.test("통제된 한 바이트 공급", async () => {
          assert.deepEqual(normalize(await runInputCli(item.argv, bytes, undefined, undefined, preload)), expected);
        });
        for (const malformed of [Buffer.from("{"), Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xeb, 0xa6])])]) {
          await writeFile(file, malformed);
          const reference = await runInputCli(item.argv, malformed, undefined, file);
          const received = await runInputCli(item.argv, malformed);
          assert.notEqual(reference.code, 0);
          assert.equal(received.code, reference.code, "파일과 stdin 오류 종료 판정");
          if (reference.stdout) {
            const actualError = JSON.parse(received.stdout), expectedError = JSON.parse(reference.stdout);
            if (kind === "profile-workspace") { delete actualError.observedAt; delete expectedError.observedAt; }
            assert.deepEqual(actualError, expectedError);
          }
          else assert.match(received.stderr, /SyntaxError/);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
