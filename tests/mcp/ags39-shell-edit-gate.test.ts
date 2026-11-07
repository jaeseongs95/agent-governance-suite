import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";

// AGS3-D-0005 remainder: shell and script writes the 3.8.0 observation left uncounted (`&&`, `cd`, tee, sed -i, cp, mv,
// inline interpreter code, PowerShell positional paths, agy run_command on Windows). Synthetic native hook inputs at the
// public adapter/gate boundary; no shell runs. The repository checkout is the version-controlled fixture root.
const repo = fileURLToPath(new URL("../../.phase-fixture/shell-edit-gate", import.meta.url));
const file = (name: string) => path.resolve(repo, name);
const stores = new Set<SqliteContinuityStore>();
const hosts = [
  ["codex", "exec_command", "cmd"],
  ["claude-code", "Bash", "command"],
  ["antigravity", "Bash", "CommandLine"],
] as const;
let calls = 0;
const boundary = (host: string, tool: string, toolInput: Record<string, unknown>) => ({
  hook_event_name: "PreToolUse", session_id: `ags39-shell-${host}`, cwd: repo, tool_name: tool, tool_input: toolInput,
  tool_use_id: `call-${++calls}`,
});
const shell = (host: string, tool: string, key: string, command: string) =>
  boundary(host, tool, host === "codex" ? { [key]: command, shell: "/bin/bash" } : { [key]: command });
const service = () => {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, null, null);
};
const denied = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny";
const observe = (host: string, input: Record<string, unknown>) => adaptHostInput(input, host).observation;

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

describe("AGS3-D-0005 shell writes the 3.8.0 observation missed", () => {
  // Expected targets come from the shell semantics of each command, not from the parser.
  it.each([
    ["SW01 cd then &&", "cd src && printf a > a.ts", [file("src/a.ts")]],
    ["SW02 subshell cd scope", "(cd src && printf a > a.ts); printf b > b.ts", [file("src/a.ts"), file("b.ts")]],
    ["SW03 tee", "printf a | tee src/a.ts src/b.ts", [file("src/a.ts"), file("src/b.ts")]],
    ["SW04 sed -i", "sed -i 's/a/b/' src/a.ts src/b.ts", [file("src/a.ts"), file("src/b.ts")]],
    ["SW05 cp", "cp /tmp/x.ts src/a.ts", [file("src/a.ts")]],
    ["SW06 mv", "mv src/old.ts src/new.ts", [file("src/old.ts"), file("src/new.ts")]],
    ["SW07 cp into directory", "cp a.ts b.ts src/", [file("src/a.ts"), file("src/b.ts")]],
    ["SW08 rm", "rm -f src/gone.ts", [file("src/gone.ts")]],
    ["SW09 bash -c", "bash -c 'printf a > src/a.ts'", [file("src/a.ts")]],
    ["SW10 if/then", "if true; then printf a > src/a.ts; fi", [file("src/a.ts")]],
    ["SW11 git mv", "git mv src/a.ts src/b.ts", [file("src/a.ts"), file("src/b.ts")]],
    ["SW12 heredoc after cd", "cd src && cat > a.ts <<'EOF'\nx > fake.ts\nEOF", [file("src/a.ts")]],
  ])("%s: %s", (_name, command, expected) => {
    for (const [host, tool, key] of hosts) {
      const observation = observe(host, shell(host, tool, key, command));
      expect(observation.editTargets, host).toEqual(expected);
      expect(observation.editTargetsIncomplete, host).toBeUndefined();
    }
  });

  it.each([
    ["SU01 variable target", "printf a > \"$TARGET\""],
    ["SU02 python inline write", "python3 -c \"open('src/a.ts','w').write('x')\""],
    ["SU03 node inline write", "node -e \"require('fs').writeFileSync('src/a.ts','x')\""],
    ["SU04 python heredoc write", "python3 - <<'EOF'\nfrom pathlib import Path\nPath('src/a.ts').write_text('x')\nEOF"],
    ["SU05 glob rm", "rm src/*.ts"],
    ["SU06 xargs rm", "git ls-files src | xargs rm"],
    ["SU07 find -delete", "find src -name '*.tmp' -delete"],
    ["SU08 git apply", "git apply fix.patch"],
    ["SU09 perl -pi", "perl -pi -e 's/a/b/' src/a.ts"],
    ["SU10 cd to variable", "cd \"$DIR\" && printf a > a.ts"],
    // Marker names with a suffix (Sync, Async, plural): a trailing word boundary on the bare name missed them.
    ["SU12 node appendFileSync", "node -e \"require('fs').appendFileSync('src/a.ts','x')\""],
    ["SU13 node copyFileSync", "node -e \"require('fs').copyFileSync('x','src/a.ts')\""],
    ["SU14 node openSync for writing", "node -e \"const fs=require('fs');fs.writeSync(fs.openSync('src/a.ts','w'),'x')\""],
    ["SU15 deno writeTextFileSync", "deno eval \"Deno.writeTextFileSync('src/a.ts','x')\""],
    ["SU16 python os.removedirs", "python3 -c \"import os; os.removedirs('src/empty')\""],
    ["SU17 python os.renames", "python3 -c \"import os; os.renames('src/a.ts','lib/a.ts')\""],
  ])("%s counts one write whose file is unnamed: %s", (_name, command) => {
    for (const [host, tool, key] of hosts) expect(observe(host, shell(host, tool, key, command)).editTargets, host).toEqual([]);
  });

  it("SU11: a named write next to an unnamed one counts both", () => {
    for (const [host, tool, key] of hosts) {
      const observation = observe(host, shell(host, tool, key, "printf a > src/a.ts; python3 -c \"open('q.ts','w')\""));
      expect(observation.editTargets, host).toEqual([file("src/a.ts")]);
      expect(observation.editTargetsIncomplete, host).toBe(true);
    }
  });

  it.each(hosts)("SG01: %s denies the third file written by one shell call with cd, && and heredocs", (host, tool, key) => {
    const command = "cd src && cat > a.ts <<'EOF'\na\nEOF\ncat > b.ts <<'EOF'\nb\nEOF\ncat > c.ts <<'EOF'\nc\nEOF\n";
    expect(denied(handleContinuityHook(shell(host, tool, key, command), service(), host, {}, "en"))).toBe(true);
  });

  it.each(hosts)("SG02: %s denies the third unnamed script write without a workflow", (host, tool, key) => {
    const target = service();
    const write = () => handleContinuityHook(shell(host, tool, key, "python3 -c \"open('src/a.ts','w').write('x')\""), target, host, {}, "en");
    expect(write()).toEqual({});
    expect(write()).toEqual({});
    expect(denied(write())).toBe(true);
  });

  it.each(hosts)("SG03: %s counts a mixed named+unnamed call as two files", (host, tool, key) => {
    const target = service();
    expect(handleContinuityHook(shell(host, tool, key, "printf a > src/a.ts; node -e \"require('fs').writeFileSync('x','y')\""), target, host, {}, "en")).toEqual({});
    expect(denied(handleContinuityHook(shell(host, tool, key, "printf c > src/c.ts"), target, host, {}, "en"))).toBe(true);
  });
});

describe("AGS3-D-0005 PowerShell and agy dialects", () => {
  it.each([
    ["PS01 positional Set-Content", "Set-Content src/a.ts x", [file("src/a.ts")]],
    ["PS02 piped Out-File", "'x' | Out-File src/b.ts", [file("src/b.ts")]],
    ["PS03 Remove-Item array", "Remove-Item src/a.ts, src/b.ts -Force", [file("src/a.ts"), file("src/b.ts")]],
    ["PS04 Copy-Item destination", "Copy-Item -Path x.ts -Destination src/c.ts", [file("src/c.ts")]],
    ["PS05 Set-Location then write", "Set-Location src; Add-Content a.ts x", [file("src/a.ts")]],
    ["PS06 New-Item file", "New-Item -ItemType File -Path src/n.ts -Value x", [file("src/n.ts")]],
  ])("%s: %s", (_name, command, expected) => {
    expect(observe("claude-code", boundary("claude-code", "PowerShell", { command })).editTargets).toEqual(expected);
    expect(observe("codex", boundary("codex", "shell_command", { command, shell: "powershell.exe" })).editTargets).toEqual(expected);
  });

  it.each([
    ["PU01 pipeline Remove-Item", "Get-ChildItem src -Filter *.tmp | Remove-Item"],
    ["PU02 .NET write", "[IO.File]::WriteAllText('src/a.ts', 'x')"],
    ["PU03 wildcard -Path", "Set-Content -Path 'src/*.ts' -Value x"],
  ])("%s counts an unnamed write: %s", (_name, command) => {
    expect(observe("claude-code", boundary("claude-code", "PowerShell", { command })).editTargets).toEqual([]);
  });

  it("AG01: agy run_command on Windows also reads PowerShell writes; a POSIX heredoc stays data", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const agy = (command: string) => observe("antigravity", boundary("antigravity", "Bash", { CommandLine: command })).editTargets;
      expect(agy("Set-Content src/a.ts x; 'y' | Out-File src/b.ts")).toEqual([file("src/a.ts"), file("src/b.ts")]);
      expect(agy("printf a > src/a.ts")).toEqual([file("src/a.ts")]);
      expect(agy("python3 - <<'EOF'\nif 1 > 0: print(1)\nEOF")).toBeUndefined();
      expect(agy("Get-Content src/a.ts | Select-String x")).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});

describe("AGS3-D-0005 read-only commands are not edits (no over-blocking)", () => {
  const posixReadOnly = [
    "git status --short", "git diff --stat", "git log --oneline -5 > /dev/null", "ls -la src", "cat src/a.ts | grep x",
    "grep -rn foo src 2>/dev/null", "find . -name '*.ts' -not -path './node_modules/*'", "sed -n '1,5p' src/a.ts",
    "cd src && ls", "ls && cat src/a.ts", "node --version", "pnpm test", "npx vitest run tests/x.test.ts",
    "python3 -m pytest -q", "python3 -c \"print(open('src/a.ts').read())\"", "node -e \"console.log(require('fs').readFileSync('a','utf8'))\"",
    "echo $(cat src/a.ts)", "git diff | head -20", "pnpm lint 2>&1 | tail -5", "for f in src/*.ts; do wc -l \"$f\"; done",
    "if [ -f a ]; then cat a; fi", "printf 'a > fake.ts'", "# printf a > fake.ts", "printf a >&2", "git show HEAD:src/a.ts",
    "rg -n 'x > y' src", "xargs -0 grep -l foo < list.txt", "find src -name '*.ts' -exec grep -l x {} +", "git checkout -b topic",
    "python3 - <<'EOF'\nprint(1 > 0)\nEOF", "env FOO=1 node scripts/check.mjs", "timeout 10 git fetch -q",
    "node -e \"const fs=require('fs');console.log(fs.readFileSync(fs.openSync('a','r'),'utf8'))\"",
  ];
  it.each(hosts)("RO01: %s leaves read-only shell commands uncounted and the first edit allowed", (host, tool, key) => {
    const target = service();
    for (const command of posixReadOnly) {
      const input = shell(host, tool, key, command);
      expect(observe(host, input).editTargets, command).toBeUndefined();
      for (let count = 0; count < 3; count++) expect(handleContinuityHook(input, target, host, {}, "en"), command).toEqual({});
    }
    expect(handleContinuityHook(boundary(host, host === "codex" ? "apply_patch" : "Write", host === "codex"
      ? { command: "*** Begin Patch\n*** Update File: src/first.ts\n*** End Patch" }
      : host === "antigravity" ? { TargetFile: file("src/first.ts") } : { file_path: file("src/first.ts") }), target, host, {}, "en")).toEqual({});
  });

  it.each([
    "Get-Content src/a.ts", "Select-String -Path src/a.ts -Pattern x", "Get-ChildItem src | Select-Object Name",
    "git status 2>$null", "Test-Path src/a.ts", "Get-Content src/a.ts | Measure-Object -Line",
    "if (Test-Path a) { Get-Content a }", "Write-Output x > $null", "Set-Location src; Get-ChildItem",
  ])("RO02: PowerShell read-only %s is not an edit", command => {
    expect(observe("claude-code", boundary("claude-code", "PowerShell", { command })).editTargets).toBeUndefined();
    expect(observe("codex", boundary("codex", "shell_command", { command, shell: "powershell.exe" })).editTargets).toBeUndefined();
  });
});
