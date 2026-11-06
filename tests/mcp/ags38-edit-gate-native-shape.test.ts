import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";

// Public primary-source fixture; native-shaped inputs, NOT a real host run.
const fixtureMetadata = {
  version: "rust-v0.166.0",
  handler: {
    url: "https://raw.githubusercontent.com/openai/codex/rust-v0.166.0/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs",
    utf8Sha256: "541ce03d24f0f67dec4bd4e1728ce9e39ade3744f04573b16f714682efd95404",
    lines: "319-329",
  },
  canonicalName: {
    url: "https://raw.githubusercontent.com/openai/codex/rust-v0.166.0/codex-rs/core/src/tools/hook_names.rs",
    utf8Sha256: "ab0f235f27bc063feb6468d8d0d57201a08538798cfe45dd8008eab60d991553",
    lines: "47-50",
  },
} as const;

const repo = fileURLToPath(new URL("../../.phase-fixture/native-edit-gate", import.meta.url));
const file = (name: string) => path.resolve(repo, name);
const stores = new Set<SqliteContinuityStore>();
const session = "ags38-native-edit-gate";
const boundary = (command: string, actor: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", session_id: session, cwd: repo, tool_use_id: "native-call",
  tool_name: "Bash", tool_input: { command }, ...actor,
});
const service = () => {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, null, null);
};
const denied = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny";
const command = "printf a > src/a.ts; printf b > src/b.ts; printf c > src/c.ts";

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe(`AGS3-D-0005 Codex ${fixtureMetadata.version} native shell schema`, () => {
  it("NS01: routes the canonical Bash hook name to continuity", () => {
    const config = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
    };
    expect(config.hooks.PreToolUse.some(entry => new RegExp(entry.matcher ?? ".*").test("Bash")
      && entry.hooks.some(hook => hook.command.includes("continuity-hook.mjs")))).toBe(true);
  });

  it.each([
    ["root", {}],
    ["observed child", { agent_id: "native-child" }],
  ] as const)("NS02/NS03: %s native Bash/command reaches the existing three-file gate", (_name, actor) => {
    const input = boundary(command, actor);
    expect(adaptHostInput(input, "codex").observation.editTargets).toEqual([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]);
    expect(denied(handleContinuityHook(input, service(), "codex", {}, "en"))).toBe(true);
  });

  it.each([
    ["root", {}],
    ["observed child", { agent_id: "native-child" }],
  ] as const)("NS04: %s native read-only shell contributes no unknown edit", (_name, actor) => {
    const target = service();
    for (const readOnly of ["git status --short", "cat src/a.ts", "printf 'data > fake.ts'"]) {
      const input = boundary(readOnly, actor);
      expect(adaptHostInput(input, "codex").observation.editTargets).toBeUndefined();
      for (let count = 0; count < 4; count++) expect(handleContinuityHook(input, target, "codex", {}, "en")).toEqual({});
    }
    const patch = (name: string) => ({ ...boundary("", actor), tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${name}\n*** End Patch` } });
    for (const name of ["src/a.ts", "src/b.ts"]) expect(handleContinuityHook(patch(name), target, "codex", {}, "en")).toEqual({});
    expect(denied(handleContinuityHook(patch("src/c.ts"), target, "codex", {}, "en"))).toBe(true);
  });

  it.each([
    ["claude-code", "command"],
    ["antigravity", "CommandLine"],
  ] as const)("NS05: preserves %s literal denial and read-only classification", (host, key) => {
    const input = { ...boundary(command), tool_input: { [key]: command } };
    expect(denied(handleContinuityHook(input, service(), host, {}, "en"))).toBe(true);
    expect(adaptHostInput({ ...input, tool_input: { [key]: "git status --short" } }, host).observation.editTargets).toBeUndefined();
  });
});
