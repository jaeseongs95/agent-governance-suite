import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";

// Synthetic native hook inputs at the public adapter/gate boundary. No host or shell is executed.
const repo = fileURLToPath(new URL("../../.phase-fixture/edit-gate", import.meta.url));
const stores = new Set<SqliteContinuityStore>();
const session = "ags38-edit-gate";
const file = (name: string) => path.resolve(repo, name);
const boundary = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", session_id: session, cwd: repo, tool_name: tool, tool_input: toolInput, ...extra,
});
const service = () => {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, null, null);
};
const denied = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny";

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe("AGS3-D-0005 observable shell write targets", () => {
  it("EG01: the shipped Codex hook routes shell boundaries to continuity", () => {
    const config = JSON.parse(readFileSync(new URL("../../hooks/hooks.json", import.meta.url), "utf8")) as {
      hooks: { PreToolUse: { matcher?: string; hooks: { command: string }[] }[] };
    };
    for (const tool of ["apply_patch", "exec_command", "shell", "shell_command"]) {
      expect(config.hooks.PreToolUse.some(entry => new RegExp(entry.matcher ?? ".*").test(tool)
        && entry.hooks.some(hook => hook.command.includes("continuity-hook.mjs")))).toBe(true);
    }
  });

  it.each([
    ["codex", "exec_command", "cmd"],
    ["claude-code", "Bash", "command"],
    ["antigravity", "Bash", "CommandLine"],
  ])("EG01/EG03: %s rejects three explicit output paths before execution", (host, tool, key) => {
    const input = boundary(tool!, { [key!]: "printf a > src/a.ts; printf b >> src/b.ts; printf c > 'src/c file.ts'" });
    expect(adaptHostInput(input, host!).observation.editTargets).toEqual([file("src/a.ts"), file("src/b.ts"), file("src/c file.ts")]);
    expect(denied(handleContinuityHook(input, service(), host!, {}, "en"))).toBe(true);
  });

  it("EG02: skips heredoc bodies while counting literal output destinations", () => {
    const command = "cat > src/a.ts <<'EOF'\nnot a command > fake.ts\nEOF\ncat <<'EOF' > src/b.ts\nb\nEOF\ncat > src/c.ts <<'EOF'\nc\nEOF\n";
    const input = boundary("Bash", { command });
    expect(adaptHostInput(input, "claude-code").observation.editTargets).toEqual([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")]);
    expect(denied(handleContinuityHook(input, service(), "claude-code", {}, "en"))).toBe(true);
  });

  it("EG04: counts explicit PowerShell content/output paths", () => {
    const input = boundary("PowerShell", { command: "Set-Content -LiteralPath 'src/a.ts' -Value a; Add-Content -Path src/b.ts -Value b; 'c' | Out-File -FilePath 'src/c file.ts'" });
    expect(adaptHostInput(input, "claude-code").observation.editTargets).toEqual([file("src/a.ts"), file("src/b.ts"), file("src/c file.ts")]);
    expect(denied(handleContinuityHook(input, service(), "claude-code", {}, "en"))).toBe(true);
  });

  it.each(["printf 'a > fake.ts'", "cat src/a.ts", "git status --short", "# printf a > fake.ts", "printf a > /dev/null", "printf a >&2"])("EG05/EG11: does not invent an edit for %s", command => {
    const input = boundary("Bash", { command });
    expect(adaptHostInput(input, "claude-code").observation.editTargets).toBeUndefined();
    const target = service();
    for (let index = 0; index < 4; index++) expect(handleContinuityHook(input, target, "claude-code", {}, "en")).toEqual({});
    expect(handleContinuityHook(boundary("Write", { file_path: file("first.ts") }), target, "claude-code", {}, "en")).toEqual({});
  });

  it("EG06/EG07: shares the distinct-file window with existing file tools", () => {
    const target = service();
    for (const input of [boundary("Write", { file_path: file("src/a.ts") }), boundary("Bash", { command: "printf a > src/a.ts; printf b > src/b.ts" })]) {
      expect(handleContinuityHook(input, target, "claude-code", {}, "en")).toEqual({});
    }
    expect(denied(handleContinuityHook(boundary("Bash", { command: "printf c > src/c.ts" }), target, "claude-code", {}, "en"))).toBe(true);
  });

  it("EG08: preserves the observed child's existing parent edit window", () => {
    const target = service();
    for (const name of ["a.ts", "b.ts"]) expect(handleContinuityHook(boundary("Write", { file_path: file(name) }), target, "claude-code", {}, "en")).toEqual({});
    expect(denied(handleContinuityHook(boundary("Bash", { command: "printf c > c.ts" }, { agent_id: "child" }), target, "claude-code", {}, "en"))).toBe(true);
  });

  it("EG09/EG11: does not turn PostToolUse or unresolved variables into literal write targets", () => {
    expect(adaptHostInput(boundary("Bash", { command: "printf a > src/a.ts" }, { hook_event_name: "PostToolUse" }), "claude-code").observation.editTargets).toBeUndefined();
    // An unresolved variable is not fabricated into a file name; the write still counts as one unnamed file (AGS3-D-0005).
    expect(adaptHostInput(boundary("Bash", { command: "printf a > \"$TARGET\"" }), "claude-code").observation.editTargets).toEqual([]);
  });
});
