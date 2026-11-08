import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeAntigravityHookEvent } from "../../antigravity-connector/hooks/antigravity-hook-runner.mjs";
import { resolveSkillUsageDatabasePath, skillUsageSummary } from "../../mcp-server/src/skill-usage-store.js";

// agy's runner answers a tool's end before any other stage runs, so the adapter cases in skill-usage.test.ts cannot show
// that a real read reaches the statistics. These drive the runner with agy's own hook input and the built bundle.
const SKILL_FILE = fileURLToPath(new URL("../../skills/code-review/SKILL.md", import.meta.url));
const readFile = (Path: string) => ({ conversationId: "agy-1", workspacePaths: [tmpdir()], toolCall: { name: "read_file", args: { Path } } });

let directory = "";
let usageFile = "";
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-skill-usage-agy-"));
  const layers = path.join(directory, "layers.sqlite3");
  vi.stubEnv("AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH", layers);
  usageFile = resolveSkillUsageDatabasePath({ AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: layers });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("antigravity's runner reaches the statistics at a tool's end", () => {
  it("a read of a skill file is recorded through the built bundle", async () => {
    expect(await executeAntigravityHookEvent(readFile(SKILL_FILE), "PostToolUse")).toEqual({});
    expect(skillUsageSummary(usageFile, 1).rows).toMatchObject([{ skillId: "code-review", host: "antigravity", basis: "skill-file-read", calls: 1 }]);
  });

  it("any other tool's end leaves the bundle unloaded", async () => {
    const skillCallRecorder = vi.fn();
    expect(await executeAntigravityHookEvent(readFile(path.join(tmpdir(), "notes.txt")), "PostToolUse", undefined, { skillCallRecorder })).toEqual({});
    expect(skillCallRecorder).not.toHaveBeenCalled();
    await executeAntigravityHookEvent(readFile(SKILL_FILE), "PostToolUse", undefined, { skillCallRecorder });
    expect(skillCallRecorder).toHaveBeenCalledOnce();
  });
});
