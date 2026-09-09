import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { portablePath, profileWorkspace } from "../../skills/workspace-convention-profiler/scripts/profile-workspace.mjs";
import { validateProfile } from "../../skills/workspace-convention-profiler/scripts/validate-profile.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "workspace-convention-profiler");
const fixtures = path.join(testRoot, "fixtures");
const request = (workspaceRoot, overrides = {}) => ({
  schemaVersion: "1.0.0", workspaceRoot, taskObjective: "fixture 조사", targetPaths: ["src"], resolvedInstructionRefs: [], knownConstraints: [],
  evidenceLimits: { maxFiles: 100, maxBytesPerFile: 100000, excludedPatterns: [] }, ...overrides,
});

async function treeDigest(directory) {
  const rows = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else rows.push(`${portablePath(path.relative(directory, absolute))}:${createHash("sha256").update(await readFile(absolute)).digest("hex")}`);
    }
  }
  await walk(directory);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

test("Node monorepo를 읽기 전용으로 조사하고 결정적 fingerprint를 만든다", async (context) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "workspace-profiler-non-git-"));
  context.after(() => rm(fixture, { recursive: true, force: true }));
  await cp(path.join(fixtures, "node-monorepo"), fixture, { recursive: true });
  const before = await treeDigest(fixture);
  const first = await profileWorkspace(request(fixture));
  const second = await profileWorkspace(request(fixture));
  assert.equal(first.verdict, "PASS");
  assert.equal(first.profileFingerprint, second.profileFingerprint);
  assert.equal(first.workspace.vcsType, "none");
  assert.ok(first.ecosystems.some((item) => item.language === "JavaScript/TypeScript" && item.packageManager === "pnpm"));
  assert.ok(first.commands.some((item) => item.command === "pnpm build"));
  assert.ok(first.openQuestions.some((item) => item.includes("test 목적의 명령")));
  assert.equal(await treeDigest(fixture), before);
  assert.deepEqual(validateProfile(first), []);
});

test("혼합 생태계와 희소 저장소를 처리한다", async () => {
  const mixed = await profileWorkspace(request(path.join(fixtures, "mixed")));
  assert.deepEqual(new Set(mixed.ecosystems.map((item) => item.language)), new Set(["JavaScript/TypeScript", "Go"]));
  const sparse = await profileWorkspace(request(path.join(fixtures, "sparse"), { targetPaths: [] }));
  assert.equal(sparse.verdict, "PASS");
  assert.equal(sparse.commands.length, 0);
});

test("taskObjective와 targetPaths 변경은 profile fingerprint를 무효화한다", async () => {
  const workspace = path.join(fixtures, "node-monorepo");
  const baseline = await profileWorkspace(request(workspace));
  const changedObjective = await profileWorkspace(request(workspace, { taskObjective: "다른 작업 조사" }));
  const changedTargets = await profileWorkspace(request(workspace, { targetPaths: ["tests"] }));
  assert.notEqual(changedObjective.profileFingerprint, baseline.profileFingerprint);
  assert.notEqual(changedTargets.profileFingerprint, baseline.profileFingerprint);
  assert.notDeepEqual(changedTargets.changeHotspots, baseline.changeHotspots);
});

test("Git currentRef와 관측한 디렉터리 구조 변경은 fingerprint를 무효화한다", async (context) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "workspace-profiler-ref-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  await cp(path.join(fixtures, "sparse"), workspace, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: workspace });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: workspace, stdio: "ignore" });
  const main = await profileWorkspace(request(workspace, { targetPaths: [] }));
  execFileSync("git", ["switch", "-c", "alternate"], { cwd: workspace, stdio: "ignore" });
  const alternate = await profileWorkspace(request(workspace, { targetPaths: [] }));
  assert.notEqual(alternate.profileFingerprint, main.profileFingerprint);
  await mkdir(path.join(workspace, "new-area", "nested"), { recursive: true });
  const changedStructure = await profileWorkspace(request(workspace, { targetPaths: [] }));
  assert.notEqual(changedStructure.profileFingerprint, alternate.profileFingerprint);
});

test("confirmed 관례와 모든 criterion ref는 checksum evidence index에 결속된다", async () => {
  const output = await profileWorkspace(request(path.join(fixtures, "node-monorepo")));
  assert.ok(output.evidenceIndex.some((item) => item.kind === "directory" && item.locator.endsWith("/")));
  assert.ok(output.structure.every((item) => item.evidenceRefs.every((ref) => /^.+\/#sha256:[a-f0-9]{64}$/.test(ref))));
  const tampered = structuredClone(output);
  tampered.conventions[0].evidenceRefs = ["does/not/exist/"];
  assert.ok(validateProfile(tampered).some((error) => error.includes("references missing evidence")));
  const commandTampered = structuredClone(output);
  commandTampered.commands[0].sourceRef = "missing.json#sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.ok(validateProfile(commandTampered).some((error) => error.includes("references missing evidence")));
});

test("request 런타임 검증은 schemaVersion, item과 additionalProperties를 엄격히 적용한다", async () => {
  const workspace = path.join(fixtures, "node-monorepo");
  const invalidRequests = [
    request(workspace, { schemaVersion: "2.0.0" }),
    request(workspace, { targetPaths: [1] }),
    request(workspace, { targetPaths: ["src", "src"] }),
    { ...request(workspace), unexpected: true },
    request(workspace, { evidenceLimits: { maxFiles: 5001, maxBytesPerFile: 100, excludedPatterns: [] } }),
  ];
  for (const input of invalidRequests) {
    const output = await profileWorkspace(input);
    assert.equal(output.verdict, "BLOCKED");
    assert.match(output.limitations[0], /계약 위반/);
    assert.deepEqual(validateProfile(output), []);
  }
});

test("validateProfile은 전체 output schema를 적용한다", async () => {
  const output = await profileWorkspace(request(path.join(fixtures, "node-monorepo")));
  const extraProperty = structuredClone(output);
  extraProperty.unexpected = true;
  assert.ok(validateProfile(extraProperty).some((error) => error.startsWith("schema")));
  const invalidArrayItem = structuredClone(output);
  invalidArrayItem.openQuestions.push(42);
  assert.ok(validateProfile(invalidArrayItem).some((error) => error.startsWith("schema")));
});

test("workspace 밖 대상과 Windows 경로 표현을 안전하게 처리한다", async () => {
  const output = await profileWorkspace(request(path.join(fixtures, "node-monorepo"), { targetPaths: ["../outside"] }));
  assert.equal(output.verdict, "BLOCKED");
  assert.match(output.limitations[0], /workspace 밖/);
  assert.equal(portablePath("C:\\Repo\\src\\file.ts"), "c:/Repo/src/file.ts");
  assert.equal(portablePath("D:/Repo//tests"), "d:/Repo/tests");
});

test("dirty Git worktree를 관측해도 변경하지 않는다", async (context) => {
  const temporary = await mkdtemp(path.join(tmpdir(), "workspace-profiler-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(path.join(fixtures, "dirty"), temporary, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: temporary, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: temporary });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: temporary });
  execFileSync("git", ["add", "."], { cwd: temporary });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: temporary, stdio: "ignore" });
  await writeFile(path.join(temporary, "src", "index.js"), "export const clean = false;\n");
  const before = execFileSync("git", ["status", "--porcelain=v1"], { cwd: temporary, encoding: "utf8" });
  const output = await profileWorkspace(request(temporary));
  const after = execFileSync("git", ["status", "--porcelain=v1"], { cwd: temporary, encoding: "utf8" });
  assert.equal(output.workspace.dirtyState, "dirty");
  assert.equal(after, before);
});

test("계약과 실제 JSON CLI 직접 호출이 동작한다", async () => {
  const input = request(path.join(fixtures, "python"));
  const processResult = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "profile-workspace.mjs")], { input: JSON.stringify(input), encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(processResult.status, 0, processResult.stderr);
  const output = JSON.parse(processResult.stdout);
  const inputSchema = JSON.parse(await readFile(path.join(skillRoot, "contracts", "workspace-profile-request.v1.schema.json"), "utf8"));
  const schema = JSON.parse(await readFile(path.join(skillRoot, "contracts", "workspace-convention-profile.v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ strict: true, formats: { "date-time": true } });
  assert.equal(ajv.compile(inputSchema)(input), true);
  assert.equal(ajv.compile(schema)(output), true);
  assert.equal(output.verdict, "PASS");
});

test("behavior fixture에 정상·경계·예상 실패 사례가 있다", async () => {
  const cases = JSON.parse(await readFile(path.join(testRoot, "behavior-cases.json"), "utf8")).cases;
  assert.deepEqual(new Set(cases.map((item) => item.class)), new Set(["normal", "boundary", "expected-failure"]));
});

test("실행 코드가 suite 모듈이나 MCP에 의존하지 않는다", async () => {
  const source = await readFile(path.join(skillRoot, "scripts", "profile-workspace.mjs"), "utf8");
  assert.doesNotMatch(source, /agent-governance-suite|mcp-server|skills\\registry/);
});
