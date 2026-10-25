import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { profileWorkspace } from "../../skills/workspace-convention-profiler/scripts/profile-workspace.mjs";
import { validateProfile } from "../../skills/workspace-convention-profiler/scripts/validate-profile.mjs";

// SOURCE ONLY: written for CG05; execution requires the existing authorized test lane.
const temporaryDirectories = [];
const request = (workspaceRoot, maxBytesPerFile = 100000) => ({
  schemaVersion: "1.0.0", workspaceRoot, taskObjective: "CG05 regression fixture", targetPaths: [],
  resolvedInstructionRefs: [], knownConstraints: [],
  evidenceLimits: { maxFiles: 100, maxBytesPerFile, excludedPatterns: [] },
});

async function workspace(files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ags-cg05-"));
  temporaryDirectories.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CG05 workspace profiler regressions", () => {
  it("AGS-D-0138: lockless scripts use npm run while the package manager stays unknown", async () => {
    const root = await workspace({ "package.json": JSON.stringify({ scripts: { build: "compile", lint: "check", test: "verify" } }) });
    const result = await profileWorkspace(request(root));
    expect(result.verdict).toBe("PASS");
    expect(result.ecosystems[0].packageManager).toBeNull();
    expect(result.commands.map(({ command }) => command).sort()).toEqual(["npm run build", "npm run lint", "npm run test"]);
    expect(result.commands.every(({ sourceRef }) => sourceRef.startsWith("package.json#sha256:"))).toBe(true);
    expect(validateProfile(result)).toEqual([]);
  });

  it.each([
    ["package-lock.json", "npm", "npm run build"],
    ["pnpm-lock.yaml", "pnpm", "pnpm build"],
    ["yarn.lock", "yarn", "yarn build"],
    ["bun.lockb", "bun", "bun build"],
  ])("AGS-D-0138: preserves %s script syntax", async (lockfile, manager, command) => {
    const root = await workspace({ "package.json": '{"scripts":{"build":"compile"}}', [lockfile]: "{}" });
    const result = await profileWorkspace(request(root));
    expect(result.verdict).toBe("PASS");
    expect(result.ecosystems[0].packageManager).toBe(manager);
    expect(result.commands.map((item) => item.command)).toEqual([command]);
    expect(result.limitations).toEqual([]);
    expect(validateProfile(result)).toEqual([]);
  });

  it("AGS-D-0139: oversized package metadata is distinguishable from absence", async () => {
    const root = await workspace();
    const absent = await profileWorkspace(request(root, 64));
    await writeFile(path.join(root, "package.json"), '{"scripts":{"build":"compile"}}'.padEnd(65, " "), "utf8");
    const omitted = await profileWorkspace(request(root, 64));
    expect(absent.limitations).toEqual([]);
    expect(omitted.verdict).toBe("PASS");
    expect(omitted.limitations).toEqual(["근거 파일을 maxBytesPerFile(64) 제한으로 생략했습니다: package.json (65 bytes)."]);
    expect(omitted.ecosystems).toEqual([]);
    expect(omitted.commands).toEqual([]);
    expect(omitted.evidenceIndex).toEqual([]);
    expect(omitted.profileFingerprint).not.toBe(absent.profileFingerprint);
    expect(validateProfile(omitted)).toEqual([]);
  });

  it("AGS-D-0139: reports every oversized evidence path in deterministic order", async () => {
    const root = await workspace({
      "AGENTS.md": "a".repeat(65), "README.md": "r".repeat(65),
      ".github/workflows/check.yml": "w".repeat(65),
    });
    const input = { ...request(root, 64), resolvedInstructionRefs: ["AGENTS.md"] };
    const first = await profileWorkspace(input);
    const second = await profileWorkspace(input);
    expect(first.verdict).toBe("PASS");
    expect(first.limitations).toEqual([
      "근거 파일을 maxBytesPerFile(64) 제한으로 생략했습니다: .github/workflows/check.yml (65 bytes).",
      "근거 파일을 maxBytesPerFile(64) 제한으로 생략했습니다: AGENTS.md (65 bytes).",
      "근거 파일을 maxBytesPerFile(64) 제한으로 생략했습니다: README.md (65 bytes).",
    ]);
    expect(first.evidenceIndex).toEqual([]);
    expect(first.commands).toEqual([]);
    expect(second.limitations).toEqual(first.limitations);
    expect(second.profileFingerprint).toBe(first.profileFingerprint);
    expect(validateProfile(first)).toEqual([]);
  });

  it("AGS-D-0139: evidence exactly at maxBytesPerFile remains included", async () => {
    const root = await workspace({ "package.json": '{"scripts":{"build":"compile"}}'.padEnd(64, " ") });
    const result = await profileWorkspace(request(root, 64));
    expect(result.verdict).toBe("PASS");
    expect(result.limitations).toEqual([]);
    expect(result.evidenceIndex).toEqual([expect.objectContaining({ locator: "package.json", size: 64, kind: "file" })]);
    expect(result.commands.map(({ command }) => command)).toEqual(["npm run build"]);
    expect(validateProfile(result)).toEqual([]);
  });
});
