import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = fileURLToPath(new URL("../../skills/instruction-scope-resolver/scripts/resolve-instruction-files.mjs", import.meta.url));

// D0137: 실제 파일과 공개 진입점을 유지하고 access 한 경계에만 오류를 주입한다.
// 원본/후보에 같은 파일을 실행한다. 로컬 제품시험은 수행하지 않는다.
async function workspace(t, override = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ags-d0137-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "AGENTS.md"), "기본 지침\n", "utf8");
  if (override) await writeFile(path.join(root, "AGENTS.override.md"), "우선 지침\n", "utf8");
  const input = path.join(root, "request.json");
  await writeFile(input, JSON.stringify({
    schemaVersion: "1.0.0", workspaceRoot: root,
    instructionRoots: [{ path: root, precedence: 10, authorized: true }],
    targets: [{ path: "src", mayNotExist: true }], externalPolicyRefs: [],
  }), "utf8");
  return { root, input };
}

function probe(input, faultPath, code, mode = "export") {
  const message = `${code}: 접근 실패, access '${faultPath}'`;
  const source = `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const originalAccess = fs.access;
    const failure = Object.assign(new Error(${JSON.stringify(message)}), {
      code: ${JSON.stringify(code)}, syscall: "access", path: ${JSON.stringify(faultPath)},
    });
    fs.access = async (target, ...args) => {
      if (${JSON.stringify(code)} !== null && target === ${JSON.stringify(faultPath)}) throw failure;
      return originalAccess(target, ...args);
    };
    syncBuiltinESMExports();
    const { resolveInstructionFiles, runCli } = await import(${JSON.stringify(pathToFileURL(entry).href)});
    if (${JSON.stringify(mode)} === "cli") await runCli(["--input", ${JSON.stringify(input)}]);
    else {
      const request = JSON.parse(await fs.readFile(${JSON.stringify(input)}, "utf8"));
      try { console.log(JSON.stringify({ ok: true, output: await resolveInstructionFiles(request) })); }
      catch (error) {
        console.log(JSON.stringify({ ok: false, output: null, sameError: error === failure,
          error: { code: error.code, message: error.message, path: error.path, syscall: error.syscall } }));
      }
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return { status: result.status, reply: JSON.parse(result.stdout), message };
}

for (const code of ["EACCES", "EPERM", "EIO"]) for (const mode of ["export", "cli"]) {
  test(`D0137 ${code} ${mode}: 접근 불가 override를 건너뛰지 않고 실패한다`, async t => {
    const { root, input } = await workspace(t);
    const candidate = path.join(root, "AGENTS.override.md");
    const { status, reply, message } = probe(input, candidate, code, mode);
    assert.equal(status, mode === "cli" ? 1 : 0);
    assert.equal(reply.ok, false, "접근 불가 override 대신 기본 지침을 선택하면 안 된다");
    assert.equal(reply.output, null);
    assert.equal(reply.error.code, code);
    assert.equal(reply.error.message, message, "오류 메시지의 작업 단계와 경로를 보존한다");
    if (mode === "export") {
      assert.equal(reply.sameError, true, "원본 오류 객체를 보존한다");
      assert.equal(reply.error.path, candidate);
      assert.equal(reply.error.syscall, "access");
    }
  });
}

for (const location of ["target", "directory"]) {
  test(`D0137 ${location}: 대상이나 조상의 접근 실패를 미존재로 바꾸지 않는다`, async t => {
    const { root, input } = await workspace(t);
    const candidate = location === "target" ? path.join(root, "src") : root;
    const { status, reply } = probe(input, candidate, "EIO");
    assert.equal(status, 0);
    assert.equal(reply.ok, false);
    assert.equal(reply.sameError, true);
    assert.equal(reply.error.code, "EIO");
    assert.equal(reply.error.path, candidate);
    assert.equal(reply.error.syscall, "access");
  });
}

for (const code of ["ENOENT", "ENOTDIR"]) for (const mode of ["export", "cli"]) {
  test(`D0137 ${code} ${mode}: 부재한 override만 건너뛰고 기본 지침을 선택한다`, async t => {
    const { root, input } = await workspace(t, false);
    const candidate = path.join(root, "AGENTS.override.md");
    // ENOENT는 실제 미존재 파일을 사용하고 ENOTDIR만 같은 access 경계에 주입한다.
    const { status, reply } = probe(input, candidate, code === "ENOENT" ? null : code, mode);
    assert.equal(status, 0);
    assert.equal(reply.ok, true);
    assert.equal(reply.output.verdict, "ANALYSIS_REQUIRED");
    assert.deepEqual(reply.output.targets[0].instructionChain.map(item => path.basename(item.path)), ["AGENTS.md"]);
    assert.equal(reply.output.targets[0].exists, true);
  });
}
