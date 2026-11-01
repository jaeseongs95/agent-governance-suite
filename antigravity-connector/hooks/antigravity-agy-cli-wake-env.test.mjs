import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { presentPaths } = vi.hoisted(() => ({ presentPaths: new Set() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: (candidate) => presentPaths.has(String(candidate)) || actual.existsSync(candidate) };
});

const { resolveAntigravityWakeEnvironment } = await import("./antigravity-hook-runner.mjs");

// agy CLI 1.4.12 (Linux test host probe, 2026-11-01): the hook's parent is the agy binary itself, run without
// --csrf_token; the hook env carries only ANTIGRAVITY_CONVERSATION_ID; ~/.gemini/config/projects holds only
// default-cli-project.json with empty projectResources. Agent tool processes, by contrast, get
// ANTIGRAVITY_AGENTAPI_EXE=<agy binary>, ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN and ANTIGRAVITY_PROJECT_ID.
let home;
beforeEach(() => {
  presentPaths.clear();
  home = mkdtempSync(path.join(os.tmpdir(), "ags-agy-hook-env-"));
  const projectsDir = path.join(home, ".gemini", "config", "projects");
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(path.join(projectsDir, "default-cli-project.json"),
    JSON.stringify({ id: "default-cli-project", name: "CLI Project", projectResources: {} }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

for (const [platform, agyPath] of [
  ["linux", "/home/fixture/.local/bin/agy"],
  ["win32", "C:\\Users\\fixture\\AppData\\Local\\agy\\bin\\agy.exe"],
]) {
  test(`agy CLI host on ${platform}: agentapi is the agy binary; the hook-hidden LS connection and project stay unresolved`, () => {
    const hostProcess = { pid: 4242, startToken: "1", command: agyPath, commandLine: `${agyPath} --dangerously-skip-permissions` };
    const options = { env: { ANTIGRAVITY_CONVERSATION_ID: "agy-conversation" }, platform, homeDir: home, projectsDir: path.join(home, ".gemini", "config", "projects") };
    const canonicalInput = { session_id: "agy-conversation", workspace_id: path.join(home, "project"), cwd: path.join(home, "project") };

    // Without the binary on disk nothing is launched from the host path.
    expect(resolveAntigravityWakeEnvironment(canonicalInput, hostProcess, options).ANTIGRAVITY_AGENTAPI_EXE).toBeUndefined();

    presentPaths.add(agyPath);
    expect({ ...resolveAntigravityWakeEnvironment(canonicalInput, hostProcess, options) }).toEqual({
      ANTIGRAVITY_AGENTAPI_EXE: agyPath,
      // One cause for the absent LS address and CSRF token, not a misleading IDE log read failure.
      ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC: "AGY_HOOK_LS_CONNECTION_NOT_EXPOSED,PROJECT_ID_NOT_MATCHED",
    });
  });
}

test("an agy-named binary outside the installer default is not taken as agentapi", () => {
  const foreign = "/home/fixture/bin/agy";
  presentPaths.add(foreign);
  const resolved = resolveAntigravityWakeEnvironment({ session_id: "s" },
    { pid: 4243, startToken: "1", command: foreign, commandLine: foreign },
    { env: {}, platform: "linux", homeDir: home, projectsDir: path.join(home, ".gemini", "config", "projects") });
  expect(resolved.ANTIGRAVITY_AGENTAPI_EXE).toBeUndefined();
  expect(resolved.ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC).not.toContain("AGY_HOOK_LS_CONNECTION_NOT_EXPOSED");
});
