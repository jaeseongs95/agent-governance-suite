import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildCanonicalHookInput,
  buildExecutionBudgetOption,
  createClaimStateTracker,
  emitStrandedClaimDiagnosticIfNeeded,
  executeAntigravityHookEvent,
  extractLinuxProcStatStartToken,
  finalizeConnectorOutput,
  formatSecretFreeClaimDiagnosticLine,
  isRecognizedAntigravityHostProcess,
  resolveAntigravityWakeEnvironment,
  resolveLongLivedHostProcess,
  runConnectorFromRaw,
  startAntigravitySessionPresenceAndRelay,
  translateCanonicalOutputToAntigravity,
} from "./antigravity-hook-runner.mjs";

const runnerPath = fileURLToPath(new URL("./antigravity-hook-runner.mjs", import.meta.url));
const TEST_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const TEST_TARGET_SESSION_ID = "00000000-0000-4000-8000-000000000002";

// R02-F04: Isolate all shared SQLite / state paths into a temporary directory so tests never touch live session state.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ags-agy-test-"));
const isolatedEnv = {
  ...process.env,
  AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(tmpDir, "shared"),
  AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(tmpDir, "session-board.sqlite3"),
  AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(tmpDir, "session-messaging"),
  AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(tmpDir, "trust.sqlite3"),
  AGENT_GOVERNANCE_DB_PATH: path.join(tmpDir, "workflows.sqlite3"),
  AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(tmpDir, "continuity.sqlite3"),
};

// Apply isolated env to in-process calls as well.
for (const [k, v] of Object.entries(isolatedEnv)) {
  if (k.startsWith("AGENT_GOVERNANCE_")) {
    process.env[k] = v;
  }
}

function runSubprocess(stdinText, args) {
  const t0 = performance.now();
  const res = spawnSync(process.execPath, [runnerPath, ...args], {
    input: stdinText,
    encoding: "utf8",
    timeout: 10000,
    env: isolatedEnv,
  });
  const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  return { ...res, elapsedMs };
}

test("executes the existing thirteen antigravity hook runner scenarios", async () => {
try {
  // 1. [F1 fail-closed test A]: Malformed JSON containing _hostAttestation on PreToolUse -> must deny (never pass through).
  {
    const malformed = '{"conversationId":"conv-1","toolCall":{"name":"call_mcp_tool","args":{"Arguments":{"_hostAttestation":"forged-token"';
    const res = runSubprocess(malformed, ["--event=PreToolUse"]);
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.decision, "deny");
    assert.match(parsed.reason, /_hostAttestation/);
  }

  // 2. [F1 fail-closed test B]: Missing sessionId with _hostAttestation -> must deny.
  {
    const noSession = JSON.stringify({
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite",
          ToolName: "plan_workflow",
          Arguments: { _hostAttestation: "forged-token" },
        },
      },
    });
    const out = await runConnectorFromRaw(noSession, ["node", runnerPath, "--event=PreToolUse"]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.decision, "deny");
  }

  // 3. [F1 + G1 Timing + R02-F04]: The real common native adapter denies unsupported actor input within the latency bound; no forged binding or state survives.
  {
    const validPayload = JSON.stringify({
      conversationId: TEST_SESSION_ID,
      agent_id: "",
      workspacePaths: [tmpDir],
      stepIdx: 42,
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite",
          ToolName: "update_session_status",
          Arguments: {
            schemaVersion: "1.0.0",
            summary: "AGS Antigravity 커넥터 격리 테스트 · 검증",
            _hostAttestation: "forged-token",
          },
        },
      },
    });
    const res = runSubprocess(validPayload, ["--event=PreToolUse"]);
    assert.equal(res.status, 0);
    assert.ok(res.elapsedMs < 3000, `Expected Handler 2 elapsedMs < 3000ms, got ${res.elapsedMs}ms`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.decision, "deny");
    assert.equal(parsed.overwrite?.Arguments?._hostAttestation, undefined);
    assert.equal(parsed.overwrite?.Arguments?._sessionBinding, undefined);
    for (const file of ["session-board.sqlite3", "trust.sqlite3", "workflows.sqlite3", "session-messaging"])
      assert.equal(existsSync(path.join(tmpDir, file)), false);
    // The public translator retains positive wrapper overwrite semantics;
    // this explicit synthetic output is not native actor authority evidence.
    const boundary = buildCanonicalHookInput(JSON.parse(validPayload), "PreToolUse", "session-board").toolBoundary;
    const routed = translateCanonicalOutputToAntigravity("PreToolUse", { hookSpecificOutput: {
      permissionDecision: "allow", updatedInput: { schemaVersion: "1.0.0", summary: "synthetic translation",
        _sessionBinding: { host: "synthetic-connector-core", sessionId: TEST_SESSION_ID } },
    } }, boundary);
    assert.equal(routed.decision, "allow");
    assert.equal(routed.overwrite.Arguments._hostAttestation, undefined);
    assert.deepEqual(routed.overwrite.Arguments._sessionBinding, { host: "synthetic-connector-core", sessionId: TEST_SESSION_ID });
  }

  // 4. [G1 + G2]: Fast --hook=host-attestation and direct calls both preserve
  // actual common native denial before any unsupported actor receives authority.
  {
    const wrapperPayload = JSON.stringify({
      conversationId: TEST_SESSION_ID,
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite",
          ToolName: "plan_workflow",
          Arguments: { schemaVersion: "1.0.0", _hostAttestation: "forged-token" },
        },
      },
    });
    const resWrapper = runSubprocess(wrapperPayload, ["--hook=host-attestation", "--event=PreToolUse"]);
    assert.equal(resWrapper.status, 0);
    assert.ok(resWrapper.elapsedMs < 2000, `Expected Handler 1 elapsedMs < 2000ms, got ${resWrapper.elapsedMs}ms`);
    const parsedWrapper = JSON.parse(resWrapper.stdout);
    assert.equal(parsedWrapper.decision, "deny");
    assert.match(parsedWrapper.reason, /_hostAttestation/);
    assert.equal(parsedWrapper.overwrite, undefined);

    const directPayload = JSON.stringify({
      conversationId: TEST_SESSION_ID,
      toolCall: {
        name: "mcp_agent-governance-suite_plan_workflow",
        args: { schemaVersion: "1.0.0", _hostAttestation: "forged-token" },
      },
    });
    const resDirect = runSubprocess(directPayload, ["--event=PreToolUse"]);
    assert.equal(resDirect.status, 0);
    const parsedDirect = JSON.parse(resDirect.stdout);
    assert.equal(parsedDirect.decision, "deny");
    assert.match(parsedDirect.reason, /_hostAttestation/);
    assert.equal(parsedDirect.overwrite, undefined);
  }

  // 5. [9517df5a Boundary 1]: Unknown or missing --event, or conflicting payload hook_event_name -> rejected ({}).
  {
    const conflict = await executeAntigravityHookEvent(
      { conversationId: TEST_SESSION_ID, hook_event_name: "PostToolUse" },
      "PreToolUse",
      "",
    );
    assert.deepEqual(conflict, {});
    const missingEvent = await executeAntigravityHookEvent({ conversationId: TEST_SESSION_ID }, "", "");
    assert.deepEqual(missingEvent, {});
  }

  // 6. [9517df5a Boundary 2]: stepIdx and caller tool_use_id are never promoted to turn_id or tool_use_id.
  {
    const built = buildCanonicalHookInput(
      {
        conversationId: TEST_SESSION_ID,
        stepIdx: 7,
        tool_use_id: "caller-supplied-id",
        toolCall: { name: "run_command", args: { CommandLine: "git status" } },
      },
      "PreToolUse",
      "session-board",
    );
    assert.equal(built.canonicalInput.turn_id, undefined);
    assert.equal(built.canonicalInput.tool_use_id, undefined);
    assert.equal(built.canonicalInput.stepIdx, undefined);
  }

  // 7. [b70204be (1) Counterexample Oracle]: Stop with terminationReason="USER_CANCELED" (or MAX_INVOCATIONS)
  // must short-circuit BEFORE invoking sessionMessageHook claim, even when a pending peer message is waiting;
  // whereas a normal Stop without terminal reason claims and returns { decision: "continue", reason }.
  {
    let claimCalls = 0;
    const fakePendingPeerHook = async () => {
      claimCalls += 1;
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "[agent-governance-suite peer message BEGIN]\n{\"message\":\"pending\"}\n[agent-governance-suite peer message END]",
        },
      };
    };

    const canceledOut = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        executionNum: 1,
        terminationReason: "USER_CANCELED",
        fullyIdle: true,
      },
      "Stop",
      "",
      { resolveHostProcess: () => null, sessionMessageHook: fakePendingPeerHook },
    );
    assert.deepEqual(canceledOut, {});
    assert.equal(claimCalls, 0, "USER_CANCELED must not invoke broker claim even when messages are pending");

    const maxInvOut = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        executionNum: 1,
        terminationReason: "MAX_INVOCATIONS",
        fullyIdle: true,
      },
      "Stop",
      "",
      { resolveHostProcess: () => null, sessionMessageHook: fakePendingPeerHook },
    );
    assert.deepEqual(maxInvOut, {});
    assert.equal(claimCalls, 0, "MAX_INVOCATIONS must not invoke broker claim");

    const normalStopOut = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        executionNum: 1,
        fullyIdle: true,
      },
      "Stop",
      "",
      { resolveHostProcess: () => null, sessionMessageHook: fakePendingPeerHook },
    );
    assert.equal(claimCalls, 1, "Normal Stop must invoke broker claim once");
    assert.equal(normalStopOut.decision, "continue");
    assert.match(normalStopOut.reason, /agent-governance-suite peer message BEGIN/);
  }

  // 8. [R04-F02, R05-F01 & N1 (#3299 d826652f) Counterexample Oracle]:
  // resolveLongLivedHostProcess and isRecognizedAntigravityHostProcess strictly verify BOTH exact supported
  // executable name AND anchored standard Antigravity installation root prefix (while excluding writable temp/public
  // paths such as `/tmp/antigravity/...` and `C:\Users\Public\antigravity\...`), rejecting foreign language servers
  // (`language_server_python.exe`), prefixed/suffixed names (`notantigravity.exe`), Unix command-line argument spoofing
  // (`/usr/bin/python3 /tmp/language_server_fixture`), `node`/`nodejs`, bare binary names without path, and missing `startToken`.
  {
    // Positive unit assertions (exact binary + anchored standard installation root prefix)
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server_windows_x64.exe",
        "C:\\Users\\Lenovo\\.gemini\\antigravity\\bin\\language_server_windows_x64.exe",
      ),
      true,
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "Antigravity.exe",
        "C:\\Program Files\\Antigravity\\Antigravity.exe --inspect=0",
      ),
      true,
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "Antigravity.exe",
        "C:\\Users\\Lenovo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe",
      ),
      true,
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server_linux_x64",
        "/opt/antigravity/bin/language_server_linux_x64 --port 42100",
      ),
      true,
    );

    // Negative unit assertions (R05-F01, N1 #3299 & R07-N1/R07-N2 #3300 counterexamples)
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server",
        "/opt/antigravity/../home/x/language_server",
      ),
      false,
      "R07-N1 counterexample: dot-dot traversal /opt/antigravity/../home/x/language_server must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "antigravity.exe",
        "C:\\Program Files\\Antigravity\\..\\..\\Users\\Public\\antigravity.exe",
      ),
      false,
      "R07-N1 counterexample: Windows dot-dot traversal into Public must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "fake_runner",
        "/opt/antigravity/language_server_linux_x64",
      ),
      false,
      "R07-N1 counterexample: Unix comm mismatch with spoofed argv[0] (/opt/antigravity/language_server_linux_x64) must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server_windows_x64.exe",
        "C:\\Antigravity\\language_server_windows_x64.exe",
      ),
      false,
      "R07-N2 counterexample: C:\\Antigravity root (writable by standard Windows users) must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server_linux_x64",
        "/tmp/antigravity/language_server_linux_x64",
      ),
      false,
      "N1 counterexample: world-writable /tmp/antigravity/language_server_linux_x64 must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "antigravity.exe",
        "C:\\Users\\Public\\antigravity\\antigravity.exe",
      ),
      false,
      "N1 counterexample: public writable C:\\Users\\Public\\antigravity\\antigravity.exe must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "antigravity.exe",
        "C:\\Users\\Lenovo\\AppData\\Local\\Temp\\antigravity\\antigravity.exe",
      ),
      false,
      "N1 counterexample: user Temp directory must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess("language_server_windows_x64.exe", ""),
      false,
      "Bare binary name without installation path prefix must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server_python.exe",
        "C:\\Program Files\\Antigravity\\language_server_python.exe",
      ),
      false,
      "Foreign language server (language_server_python.exe) must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "notantigravity.exe",
        "C:\\Program Files\\Antigravity\\notantigravity.exe",
      ),
      false,
      "Prefixed/suffixed binary name (notantigravity.exe) must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "python3",
        "/usr/bin/python3 /opt/antigravity/language_server_linux_x64",
      ),
      false,
      "Unix command-line argument spoofing under python3 must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "python3",
        "/usr/bin/python3 /tmp/language_server_fixture",
      ),
      false,
      "Unix command-line argument spoofing with /tmp/language_server_fixture must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "node",
        "/usr/bin/node /opt/antigravity/language_server_linux_x64",
      ),
      false,
      "node with antigravity argument must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "nodejs",
        "/usr/bin/nodejs /opt/antigravity/antigravity",
      ),
      false,
      "nodejs with antigravity argument must be rejected",
    );
    assert.equal(
      isRecognizedAntigravityHostProcess("cmd.exe", "C:\\Windows\\System32\\cmd.exe"),
      false,
    );
    assert.equal(
      isRecognizedAntigravityHostProcess("explorer.exe", "C:\\Windows\\explorer.exe"),
      false,
    );
    assert.equal(
      isRecognizedAntigravityHostProcess(
        "language_server_linux_x64",
        "/opt/antigravity/bin/language_server_linux_x64 (deleted)",
      ),
      false,
      "#3304 (f105c266) note 1: unlinked/replaced executable with ' (deleted)' suffix must be rejected",
    );

    // 256e030b: Verify `extractLinuxProcStatStartToken` matches `mcp-server/src/process-identity.ts:16-20` (`fields[19]`)
    assert.equal(
      extractLinuxProcStatStartToken(
        "499 (language_server_linux_x64) S 1 499 499 0 -1 4194304 100 0 0 0 10 5 0 0 20 0 4 0 12345678 1000000 500",
      ),
      "12345678",
    );
    assert.equal(
      extractLinuxProcStatStartToken(
        "499 (language_server (worker 1)) S 1 499 499 0 -1 4194304 100 0 0 0 10 5 0 0 20 0 4 0 98765432 1000000 500",
      ),
      "98765432",
    );
    assert.equal(extractLinuxProcStatStartToken("malformed-stat-without-paren"), null);

    // (a) Windows chain: cmd.exe (100) -> powershell.exe (200) -> language_server_windows_x64.exe (300) -> succeeds with 300
    const winChain = new Map([
      [100, { pid: 100, parentPid: 200, name: "cmd.exe", command: "C:\\Windows\\System32\\cmd.exe", startToken: "2026-10-22T00:00:01.000Z" }],
      [200, { pid: 200, parentPid: 300, name: "powershell.exe", command: "powershell.exe", startToken: "2026-10-22T00:00:02.000Z" }],
      [300, { pid: 300, parentPid: 400, name: "language_server_windows_x64.exe", command: "C:\\Program Files\\Antigravity\\language_server_windows_x64.exe", startToken: "2026-10-22T00:00:00.000Z" }],
    ]);
    const resolvedWin = resolveLongLivedHostProcess(100, "win32", {
      inspectProcess: (pid) => winChain.get(pid) ?? null,
    });
    assert.deepEqual(resolvedWin, { pid: 300, startToken: "2026-10-22T00:00:00.000Z" });

    // (b) Shell-only chain: cmd.exe (100) -> pwsh.exe (200) -> must return null (never fall back to startPid 100)
    const shellOnlyChain = new Map([
      [100, { pid: 100, parentPid: 200, name: "cmd.exe", command: "cmd.exe", startToken: "t1" }],
      [200, { pid: 200, parentPid: 0, name: "pwsh.exe", command: "pwsh.exe", startToken: "t2" }],
    ]);
    assert.equal(
      resolveLongLivedHostProcess(100, "win32", { inspectProcess: (pid) => shellOnlyChain.get(pid) ?? null }),
      null,
    );

    // (c) R05-F01, N1 (#3299), R07-N1/R07-N2 (#3300) & #3304 (f105c266) counterexample chain:
    // cmd.exe (100) -> language_server_python.exe (200) -> notantigravity.exe (300)
    // -> python3 /tmp/language_server_fixture (350) -> nodejs /opt/antigravity/antigravity (380)
    // -> /tmp/antigravity/language_server_linux_x64 (400, N1 writable path!)
    // -> C:\Users\Public\antigravity\antigravity.exe (500, N1 public writable path!)
    // -> /opt/antigravity/../home/x/language_server_linux_x64 (600, R07-N1 dot-dot traversal!)
    // -> comm="fake_binary" with argv[0]="/opt/antigravity/language_server_linux_x64" (700, R07-N1 argv[0] spoof!)
    // -> C:\Antigravity\language_server_windows_x64.exe (800, R07-N2 C:\Antigravity root!)
    // -> /opt/antigravity/bin/language_server_linux_x64 (deleted) (900, #3304 deleted binary!) -> must return null!
    const spoofedAndWritableAncestorsChain = new Map([
      [100, { pid: 100, parentPid: 200, name: "cmd.exe", command: "C:\\Windows\\System32\\cmd.exe", startToken: "t1" }],
      [200, { pid: 200, parentPid: 300, name: "language_server_python.exe", command: "C:\\Program Files\\Antigravity\\language_server_python.exe", startToken: "t2" }],
      [300, { pid: 300, parentPid: 350, name: "notantigravity.exe", command: "C:\\Program Files\\Antigravity\\notantigravity.exe", startToken: "t3" }],
      [350, { pid: 350, parentPid: 380, name: "python3", command: "/usr/bin/python3 /tmp/language_server_fixture", startToken: "t35" }],
      [380, { pid: 380, parentPid: 400, name: "nodejs", command: "/usr/bin/nodejs /opt/antigravity/antigravity", startToken: "t38" }],
      [400, { pid: 400, parentPid: 500, name: "language_server_linux_x64", command: "/tmp/antigravity/language_server_linux_x64", startToken: "t4" }],
      [500, { pid: 500, parentPid: 600, name: "antigravity.exe", command: "C:\\Users\\Public\\antigravity\\antigravity.exe", startToken: "t5" }],
      [600, { pid: 600, parentPid: 700, name: "language_server_linux_x64", command: "/opt/antigravity/../home/x/language_server_linux_x64", startToken: "t6" }],
      [700, { pid: 700, parentPid: 800, name: "fake_binary", command: "/opt/antigravity/language_server_linux_x64", startToken: "t7" }],
      [800, { pid: 800, parentPid: 900, name: "language_server_windows_x64.exe", command: "C:\\Antigravity\\language_server_windows_x64.exe", startToken: "t8" }],
      [900, { pid: 900, parentPid: 0, name: "language_server_linux_x64", command: "/opt/antigravity/bin/language_server_linux_x64 (deleted)", startToken: "12345678" }],
    ]);
    assert.equal(
      resolveLongLivedHostProcess(100, "linux", { maxDepth: 12, inspectProcess: (pid) => spoofedAndWritableAncestorsChain.get(pid) ?? null }),
      null,
      "Chain containing foreign language_server, prefixed antigravity, python3/nodejs arg spoof, N1 writable paths, R07-N1 dot-dot/argv0 spoof, R07-N2 C:\\Antigravity, or #3304 deleted binary must return null",
    );

    // (d-1) Linux sh -c chain (256e030b): sh (501) -> node (500) -> language_server_linux_x64 (499)
    // On `platform === "linux"`, `startToken` is `/proc/<pid>/stat` `fields[19]` (`starttime` clock ticks numeric string),
    // matching `mcp-server/src/process-identity.ts:16-20` (`processStartToken`) 100%.
    const linuxChain = new Map([
      [501, { pid: 501, parentPid: 500, name: "sh", command: "/bin/sh", startToken: "12345999" }],
      [500, { pid: 500, parentPid: 499, name: "node", command: "/usr/bin/node", startToken: "12345888" }],
      [499, { pid: 499, parentPid: 1, name: "language_server_linux_x64", command: "/opt/antigravity/language_server_linux_x64", startToken: "12345678" }],
    ]);
    const resolvedLinux = resolveLongLivedHostProcess(501, "linux", {
      inspectProcess: (pid) => linuxChain.get(pid) ?? null,
    });
    assert.deepEqual(resolvedLinux, { pid: 499, startToken: "12345678" });

    // (d-2) Non-Linux Unix (`platform === "darwin"`) sh -c chain (256e030b):
    // On `darwin`, `startToken` uses `ps -p <pid> -o lstart=`, matching `mcp-server/src/process-identity.ts:21`.
    const darwinChain = new Map([
      [601, { pid: 601, parentPid: 600, name: "sh", command: "/bin/sh -c node ...", startToken: "Thu Oct 22 00:00:02 2026" }],
      [600, { pid: 600, parentPid: 599, name: "node", command: "/usr/local/bin/node wrapper.js", startToken: "Thu Oct 22 00:00:01 2026" }],
      [599, { pid: 599, parentPid: 1, name: "language_server_macos_arm64", command: "/Applications/Antigravity.app/Contents/Resources/language_server_macos_arm64", startToken: "Thu Oct 22 00:00:00 2026" }],
    ]);
    const resolvedDarwin = resolveLongLivedHostProcess(601, "darwin", {
      inspectProcess: (pid) => darwinChain.get(pid) ?? null,
    });
    assert.deepEqual(resolvedDarwin, { pid: 599, startToken: "Thu Oct 22 00:00:00 2026" });

    // (e) Missing startToken on otherwise valid Antigravity host -> must return null
    const missingStartTokenChain = new Map([
      [100, { pid: 100, parentPid: 200, name: "cmd.exe", command: "C:\\Windows\\System32\\cmd.exe", startToken: "t1" }],
      [200, { pid: 200, parentPid: 0, name: "language_server_windows_x64.exe", command: "C:\\Program Files\\Antigravity\\language_server_windows_x64.exe", startToken: "   " }],
    ]);
    assert.equal(
      resolveLongLivedHostProcess(100, "win32", { inspectProcess: (pid) => missingStartTokenChain.get(pid) ?? null }),
      null,
      "Recognized host process with missing/empty startToken must return null",
    );

    // (f) Depth overflow (> maxDepth=6 hops) -> must return null
    const deepChain = new Map([
      [1, { pid: 1, parentPid: 2, name: "cmd.exe", command: "cmd.exe", startToken: "t" }],
      [2, { pid: 2, parentPid: 3, name: "cmd.exe", command: "cmd.exe", startToken: "t" }],
      [3, { pid: 3, parentPid: 4, name: "cmd.exe", command: "cmd.exe", startToken: "t" }],
      [4, { pid: 4, parentPid: 5, name: "cmd.exe", command: "cmd.exe", startToken: "t" }],
      [5, { pid: 5, parentPid: 6, name: "cmd.exe", command: "cmd.exe", startToken: "t" }],
      [6, { pid: 6, parentPid: 7, name: "cmd.exe", command: "cmd.exe", startToken: "t" }],
      [7, { pid: 7, parentPid: 0, name: "language_server_windows_x64.exe", command: "C:\\Program Files\\Antigravity\\language_server_windows_x64.exe", startToken: "t7" }],
    ]);
    assert.equal(
      resolveLongLivedHostProcess(1, "win32", { maxDepth: 6, inspectProcess: (pid) => deepChain.get(pid) ?? null }),
      null,
    );
  }

  // 9. [b70204be (3) + G1 Timing]: PreToolUse on session-message-bound tool (prepare_session_message) runs locally without broker claim or message loss, within bounded latency.
  {
    const msgToolPayload = JSON.stringify({
      conversationId: TEST_SESSION_ID,
      workspacePaths: [tmpDir],
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite",
          ToolName: "prepare_session_message",
          Arguments: {
            schemaVersion: "1.0.0",
            targetHost: "gemini",
            targetSessionId: TEST_TARGET_SESSION_ID,
            body: "hello",
          },
        },
      },
    });
    const resMsg = runSubprocess(msgToolPayload, ["--event=PreToolUse"]);
    assert.equal(resMsg.status, 0);
    assert.ok(resMsg.elapsedMs < 3000, `Expected Handler 2 prepare_session_message elapsedMs < 3000ms, got ${resMsg.elapsedMs}ms`);
    const parsedMsg = JSON.parse(resMsg.stdout);
    // 3.0 stopgap: Antigravity is inferred root, so the common hook issues a one-use root proof.
    assert.equal(parsedMsg.decision, "allow");
    assert.equal(typeof parsedMsg.overwrite?.Arguments?._sessionProof, "string");
    assert.equal(parsedMsg.overwrite?.Arguments?._sessionBinding, undefined);
    for (const file of ["session-board.sqlite3", "trust.sqlite3", "session-messaging"])
      assert.equal(existsSync(path.join(tmpDir, file)), false);
    const boundary = buildCanonicalHookInput(JSON.parse(msgToolPayload), "PreToolUse", "session-message").toolBoundary;
    const routed = translateCanonicalOutputToAntigravity("PreToolUse", { hookSpecificOutput: {
      updatedInput: { schemaVersion: "1.0.0", targetHost: "gemini", targetSessionId: TEST_TARGET_SESSION_ID, body: "hello",
        _sessionBinding: { host: "synthetic-connector-core", sessionId: TEST_SESSION_ID } },
    } }, boundary);
    assert.equal(routed.decision, "allow");
    assert.deepEqual(routed.overwrite.Arguments._sessionBinding, { host: "synthetic-connector-core", sessionId: TEST_SESSION_ID });
  }

  // 10. [R02-F05]: Native common denial precedes advisory stages, so forged
  // binding keys cannot survive through a fail-open advisory-stage exception.
  // Both wrapper and direct reserved-key attempts remain denied without output bindings.
  {
    const forgedWrapperInput = {
      conversationId: TEST_SESSION_ID,
      workspacePaths: [tmpDir],
      toolCall: {
        name: "call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite",
          ToolName: "inspect_context",
          Arguments: {
            schemaVersion: "1.0.0",
            _hostAttestation: "forged-attestation",
            _sessionBinding: { host: "codex", sessionId: "forged-session" },
            _continuityBinding: "forged-continuity-token",
          },
        },
      },
    };
    let advisoryStageCalls = 0;
    const outWhenStagesThrow = await executeAntigravityHookEvent(
      forgedWrapperInput,
      "PreToolUse",
      "",
      {
        stageRunner: async (stage, _event, _raw, currentToolInput) => {
          advisoryStageCalls++;
          if (stage === "host-attestation") {
            return { output: {}, updatedToolInput: currentToolInput, mutated: false };
          }
          throw new Error(`Simulated stage failure in ${stage}`);
        },
      },
    );
    assert.equal(outWhenStagesThrow.decision, "deny");
    assert.match(outWhenStagesThrow.reason, /_hostAttestation/);
    assert.equal(outWhenStagesThrow.overwrite, undefined);
    // The early common governance entry owns AGS authorization. Advisory-stage
    // failure injection must not bypass it or convert unsupported input to allow.
    assert.equal(advisoryStageCalls, 0);

    const directForgedSession = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        toolCall: {
          name: "mcp_agent-governance-suite_prepare_session_message",
          args: {
            schemaVersion: "1.0.0",
            _sessionBinding: { host: "gemini", sessionId: "forged" },
          },
        },
      },
      "PreToolUse",
      "",
    );
    assert.equal(directForgedSession.decision, "deny");
    assert.match(directForgedSession.reason, /_sessionBinding/);
    assert.equal(directForgedSession.overwrite, undefined);

    const directForgedContinuity = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        toolCall: {
          name: "mcp_agent-governance-suite_inspect_context",
          args: {
            schemaVersion: "1.0.0",
            _continuityBinding: "forged-token",
          },
        },
      },
      "PreToolUse",
      "",
    );
    assert.equal(directForgedContinuity.decision, "deny");
    assert.match(directForgedContinuity.reason, /_continuityBinding/);
    assert.equal(directForgedContinuity.overwrite, undefined);
  }

  // 11. [R04-F01, R04-F04, R05-F02 & R05-F03 Full Entrypoint & Mutable Observer Oracle]:
  // Verifies BOTH helper calls AND full entrypoint (`executeAntigravityHookEvent(..., "SessionStart", "session-message", ...)`):
  // - Raw actor fields are forwarded to the common hook; callback routing alone grants no actor authority.
  // - Raw `agent_id: ""` through `executeAntigravityHookEvent` preserves `agent_id: ""` all the way to `sessionMessageHook`,
  //   and forwards 3rd arg `explicitPid` AND 4th arg `{ hostProcess: { pid, startToken }, executionBudget: { deadlineMonotonicMs, postClaimReserveMs } }`
  //   (`R05-F03` & `R05-F02` central contract `0cdb9b8b`/`feaa4fb5`).
  // - Mutable observer counterexample: even if the caller/resolver mutates the returned `{ pid, startToken }` object after resolution,
  //   the `{ hostProcess: { pid, startToken } }` passed to `sessionMessageHook` is an immutable snapshot and cannot be corrupted.
  // - Unverified host (`null` or empty `startToken`) never invokes the hook.
  {
    let pidResolvedCount = 0;
    const hookCalls = [];

    // (a) The connector routes the raw child marker; the actual common adapter denies its authority.
    await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        workspacePaths: [tmpDir],
        agent_id: "subagent-42",
      },
      "SessionStart",
      "session-message",
      {
        resolveHostProcess: () => {
          pidResolvedCount += 1;
          return { pid: 41804, startToken: "2026-10-22T00:00:00.000Z" };
        },
        sessionMessageHook: async (input, host, explicitPid, hookOptions) => {
          hookCalls.push({ input, host, explicitPid, hookOptions });
          return {};
        },
      },
    );
    assert.equal(pidResolvedCount, 1);
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].host, "antigravity"); assert.equal(hookCalls[0].input.agent_id, "subagent-42");
    const { handleSessionMessageHook } = await import("../../mcp-server/dist/session-message-hook.mjs");
    assert.deepEqual(await handleSessionMessageHook(hookCalls[0].input, hookCalls[0].host,
      hookCalls[0].explicitPid, hookCalls[0].hookOptions), {});
    for (const file of ["session-board.sqlite3", "trust.sqlite3", "session-messaging"])
      assert.equal(existsSync(path.join(tmpDir, file)), false);
    hookCalls.length = 0; pidResolvedCount = 0;

    // (b) Full entrypoint (`executeAntigravityHookEvent`) with observed main (`agent_id: ""`) + mutable observer counterexample
    const mutableHostRecord = { pid: 41804, startToken: "2026-10-22T00:00:00.000Z" };
    await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        workspacePaths: [tmpDir],
        agent_id: "",
      },
      "SessionStart",
      "session-message",
      {
        now: () => 1000,
        totalBudgetMs: 9200,
        postClaimReserveMs: 1000,
        resolveHostProcess: () => {
          pidResolvedCount += 1;
          return mutableHostRecord;
        },
        sessionMessageHook: async (input, host, explicitPid, hookOptions) => {
          // Mutate the source record before inspecting hookOptions to verify defensive immutable copy
          mutableHostRecord.pid = 99999;
          mutableHostRecord.startToken = "mutated-token-T2";
          hookCalls.push({ input, host, explicitPid, hookOptions });
          return {};
        },
      },
    );
    assert.equal(pidResolvedCount, 1);
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].host, "antigravity");
    assert.equal(hookCalls[0].explicitPid, 41804);
    assert.equal(hookCalls[0].input.agent_id, "");
    assert.deepEqual(hookCalls[0].hookOptions, {
      ensureRelay: true,
      defaultQueueWake: true,
      hostProcess: {
        pid: 41804,
        startToken: "2026-10-22T00:00:00.000Z",
      },
      executionBudget: {
        deadlineMonotonicMs: 10200,
        postClaimReserveMs: 1000,
      },
    });
    assert.equal(Object.isFrozen(hookCalls[0].hookOptions), true);
    assert.equal(Object.isFrozen(hookCalls[0].hookOptions.hostProcess), true);
    assert.equal(Object.isFrozen(hookCalls[0].hookOptions.executionBudget), true);

    // (c) Unknown actor with an unverified PID/token skips ensure without invoking the hook.
    await startAntigravitySessionPresenceAndRelay(
      {
        hook_event_name: "SessionStart",
        session_id: TEST_SESSION_ID,
        workspace_id: tmpDir,
      },
      {
        resolveHostProcess: () => null,
        sessionMessageHook: async (input, host, explicitPid, hookOptions) => {
          hookCalls.push({ input, host, explicitPid, hookOptions });
          return {};
        },
      },
    );
    assert.equal(hookCalls.length, 1, "Unverified null observation must not invoke the hook");

    await startAntigravitySessionPresenceAndRelay(
      {
        hook_event_name: "SessionStart",
        session_id: TEST_SESSION_ID,
        workspace_id: tmpDir,
      },
      {
        resolveHostProcess: () => ({ pid: 41804, startToken: "   " }),
        sessionMessageHook: async (input, host, explicitPid, hookOptions) => {
          hookCalls.push({ input, host, explicitPid, hookOptions });
          return {};
        },
      },
    );
    assert.equal(hookCalls.length, 1, "Unverified blank token must not invoke the hook");
  }

  // 12. [R04-F03 Secondary Stage Skip Oracle (Note R05-F02 boundary)]:
  // When primary stage (`session-message`) on PreInvocation consumes most of the total hook budget,
  // secondary advisory stages (`session-board`) are skipped. (Note: full 10s boundary across broker claim +
  // sync TrustStore + stdout requires the central `executionBudget` contract in COMMON-CONTRACT-CHANGE-REQUEST.r08.ko.md.)
  {
    let simulatedClockMs = 1000;
    const executedStages = [];
    const peerEnvelope = "[agent-governance-suite peer message BEGIN]\n{\"message\":\"urgent\"}\n[agent-governance-suite peer message END]";

    const preInvOut = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        workspacePaths: [tmpDir],
      },
      "PreInvocation",
      "",
      {
        now: () => simulatedClockMs,
        totalBudgetMs: 9200,
        minSecondaryBudgetMs: 1500,
        stageRunner: async (stage) => {
          executedStages.push(stage);
          if (stage === "session-message") {
            simulatedClockMs += 8100;
            return {
              output: {
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: peerEnvelope,
                },
              },
              updatedToolInput: {},
              mutated: false,
            };
          }
          return { output: {}, updatedToolInput: {}, mutated: false };
        },
      },
    );

    assert.deepEqual(executedStages, ["session-message"], "Secondary session-board stage must be skipped when remaining budget < minSecondaryBudgetMs");
    assert.deepEqual(preInvOut, {
      injectSteps: [{ systemMessage: { systemMessage: peerEnvelope } }],
    });
  }

  // 13. [R05-F02 Caller ExecutionBudget & onClaimState Observer Oracle — 0cdb9b8b / feaa4fb5 / 796904a4]:
  // Verifies:
  // (a) `options.executionBudget = { deadlineMonotonicMs, postClaimReserveMs }` (same-process `performance.now()` origin,
  //     stdout reserve excluded upfront) and `options.onClaimState` are passed to `handleSessionMessageHook` on lifecycle claim events,
  //     transitioning `before-claim` -> `claim-result-unknown` (`request-attempted`) -> `after-claim-before-output` (`response-received`)
  //     -> adapter-owned `stdout-written-not-consumed` (`markStdoutWritten`, `hostConsumedConfirmed: false`), while stripping any raw
  //     message body or authority fields from observer events.
  // (b) Observer exception counterexample: if the caller's `onClaimState` throws on `request-attempted`, the state remains
  //     `claim-result-unknown` (`observerError: true`), never regresses to `before-claim`, and never triggers a duplicate claim retry.
  // (c) Observer synchronous re-entry counterexample: if `onClaimState` recursively invokes `onClaimState`, re-entry is blocked
  //     (`reentered: true`) without state corruption or duplicate side effects.
  {
    assert.deepEqual(
      buildExecutionBudgetOption({ deadlineMonotonicMs: 9700, postClaimReserveMs: 1000 }),
      { deadlineMonotonicMs: 9700, postClaimReserveMs: 1000 },
    );

    // (a) Normal 4-state transition + raw body/authority stripping
    const observedEvents = [];
    const trackerA = createClaimStateTracker((ev) => {
      observedEvents.push(ev);
    });
    assert.equal(trackerA.getSnapshot().state, "before-claim");

    let forwardedBudget = null;
    const stopOut = await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        executionNum: 1,
        fullyIdle: true,
      },
      "Stop",
      "session-message",
      {
        entryMonotonicMs: 500,
        totalBudgetMs: 9200,
        postClaimReserveMs: 1000,
        claimTracker: trackerA,
        resolveHostProcess: () => null,
        sessionMessageHook: async (_input, _host, _pid, hookOptions) => {
          forwardedBudget = hookOptions?.executionBudget;
          hookOptions.onClaimState({ phase: "request-attempted", messageIds: [] });
          assert.equal(trackerA.getSnapshot().state, "claim-result-unknown");
          hookOptions.onClaimState({
            phase: "response-received",
            messageIds: ["msg-001"],
            body: "untrusted-secret-body",
            authorityEffect: "elevated",
          });
          assert.equal(trackerA.getSnapshot().state, "after-claim-before-output");
          return {
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: "[agent-governance-suite peer message BEGIN]\n{\"message\":\"ok\"}\n[agent-governance-suite peer message END]",
            },
          };
        },
      },
    );
    assert.deepEqual(forwardedBudget, {
      deadlineMonotonicMs: 9700,
      postClaimReserveMs: 1000,
    });
    assert.equal(stopOut.decision, "continue");
    assert.equal(observedEvents.length, 2);
    assert.deepEqual(observedEvents[0], { phase: "request-attempted", messageIds: [] });
    assert.deepEqual(observedEvents[1], { phase: "response-received", messageIds: ["msg-001"] });
    assert.equal(Object.hasOwn(observedEvents[1], "body"), false);
    assert.equal(Object.hasOwn(observedEvents[1], "authorityEffect"), false);

    trackerA.markStdoutWritten();
    assert.deepEqual(trackerA.getSnapshot(), {
      state: "stdout-written-not-consumed",
      messageIds: ["msg-001"],
      reentered: false,
      observerError: false,
      hostConsumedConfirmed: false,
    });

    // (b) Observer exception on `request-attempted` -> preserves `claim-result-unknown` and performs 0 duplicate claims
    let claimAttemptsB = 0;
    const trackerB = createClaimStateTracker(() => {
      throw new Error("Simulated observer failure");
    });
    await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        workspacePaths: [tmpDir],
      },
      "PreInvocation",
      "session-message",
      {
        entryMonotonicMs: 1000,
        totalBudgetMs: 9200,
        postClaimReserveMs: 1000,
        claimTracker: trackerB,
        resolveHostProcess: () => null,
        sessionMessageHook: async (_input, _host, _pid, hookOptions) => {
          claimAttemptsB += 1;
          hookOptions.onClaimState({ phase: "request-attempted", messageIds: [] });
          return {};
        },
      },
    );
    assert.equal(claimAttemptsB, 1, "Observer exception must never trigger a duplicate claim call");
    assert.deepEqual(trackerB.getSnapshot(), {
      state: "claim-result-unknown",
      messageIds: [],
      reentered: false,
      observerError: true,
      hostConsumedConfirmed: false,
    });

    // (c) Observer synchronous re-entry attempt -> blocked without corrupting state or messageIds
    let externalCallCountC = 0;
    let trackerC;
    trackerC = createClaimStateTracker((ev) => {
      externalCallCountC += 1;
      // Attempt synchronous re-entry with forged messageIds
      trackerC.onClaimState({
        phase: "response-received",
        messageIds: ["forged-reentrant-id"],
      });
      if (ev.phase === "response-received") {
        trackerC.onClaimState({
          phase: "request-attempted",
          messageIds: [],
        });
      }
    });
    trackerC.onClaimState({ phase: "request-attempted", messageIds: [] });
    assert.equal(externalCallCountC, 1);
    assert.deepEqual(trackerC.getSnapshot(), {
      state: "claim-result-unknown",
      messageIds: [],
      reentered: true,
      observerError: false,
      hostConsumedConfirmed: false,
    });
    trackerC.onClaimState({ phase: "response-received", messageIds: ["msg-real-002"] });
    assert.equal(externalCallCountC, 2);
    assert.deepEqual(trackerC.getSnapshot(), {
      state: "after-claim-before-output",
      messageIds: ["msg-real-002"],
      reentered: true,
      observerError: false,
      hostConsumedConfirmed: false,
    });

    // (d) #3313 N1: Secret-free / body-free / messageId-free diagnostic line on stranded claim (`claim-result-unknown` / `after-claim-before-output`)
    const stderrLines = [];
    const emittedUnknown = emitStrandedClaimDiagnosticIfNeeded(trackerB, {}, (line) => stderrLines.push(line));
    assert.equal(emittedUnknown, true);
    assert.equal(stderrLines.length, 1);
    assert.equal(stderrLines[0].includes("msg-"), false, "Diagnostic line must never contain messageIds or body");
    assert.deepEqual(JSON.parse(stderrLines[0]), {
      agsAntigravityHookDiagnostic: {
        claimState: "claim-result-unknown",
        messageCount: 0,
        reentered: false,
        observerError: true,
        hostConsumedConfirmed: false,
      },
    });
    assert.equal(
      formatSecretFreeClaimDiagnosticLine(trackerC),
      '{"agsAntigravityHookDiagnostic":{"claimState":"after-claim-before-output","messageCount":1,"reentered":true,"observerError":false,"hostConsumedConfirmed":false}}\n',
    );
    // `stdout-written-not-consumed` does NOT emit stderr unless `AGS_ANTIGRAVITY_DIAGNOSTIC_STDERR === "1"`
    assert.equal(emitStrandedClaimDiagnosticIfNeeded(trackerA, {}, (line) => stderrLines.push(line)), false);
    assert.equal(
      emitStrandedClaimDiagnosticIfNeeded(trackerA, { AGS_ANTIGRAVITY_DIAGNOSTIC_STDERR: "1" }, (line) => stderrLines.push(line)),
      true,
    );

    // (e) #3313 N2: Default `runConnectorFromRaw` anchors `entryMonotonicMs = 0` (`performance.timeOrigin`) when neither
    // `entryMonotonicMs` nor a custom `now` is provided, so `deadlineMonotonicMs === 9200` (including Node startup/import time).
    // Use `--event=PreInvocation` (primary stage idx === 0 is never skipped by `MIN_PRIMARY_HOOK_BUDGET_MS`) so this check is
    // 100% deterministic regardless of how long the parent test runner process has already been running.
    let capturedDefaultDeadline = null;
    await runConnectorFromRaw(
      JSON.stringify({
        conversationId: TEST_SESSION_ID,
      }),
      ["node", runnerPath, "--event=PreInvocation", "--hook=session-message"],
      {
        resolveHostProcess: () => null,
        sessionMessageHook: async (_input, _host, _pid, hookOptions) => {
          capturedDefaultDeadline = hookOptions?.executionBudget?.deadlineMonotonicMs;
          return {};
        },
      },
    );
    assert.equal(capturedDefaultDeadline, 9200);

    // (f) #3313 N3 & R03R09-R01 (bcbf684e):
    // 1. When remaining budget at helper entry is `< MIN_RESOLVER_BUDGET_MS` (100ms) or negative,
    //    `startAntigravitySessionPresenceAndRelay` skips resolver and hook invocation immediately.
    // 2. When helper entry has 100ms (`remainingBudgetMs() === 100`), if elapsed time before the first ancestor
    //    check leaves 80ms (`helper 100 -> loop 80`), `resolveLongLivedHostProcess` stops before invoking `inspectProcess`.
    // 3. When the first ancestor (transient shell) is inspected with 150ms remaining and consumes 70ms so the second
    //    ancestor has 80ms remaining (`second ancestor remaining 80`), `resolveLongLivedHostProcess` passes the exact
    //    150ms budget to the first query and stops before querying the second ancestor (never expanding 80ms to 100ms).
    let exhaustedResolverCalls = 0;
    let exhaustedHookCalls = 0;
    await startAntigravitySessionPresenceAndRelay(
      {
        hook_event_name: "SessionStart",
        session_id: TEST_SESSION_ID,
        workspace_id: tmpDir,
      },
      {
        remainingBudgetMs: () => 50,
        resolveHostProcess: () => {
          exhaustedResolverCalls += 1;
          return { pid: 41804, startToken: "2026-10-22T00:00:00.000Z" };
        },
        sessionMessageHook: async () => {
          exhaustedHookCalls += 1;
          return {};
        },
      },
    );
    assert.equal(exhaustedResolverCalls, 0, "Resolver must be skipped when remainingBudgetMs < 100ms");
    assert.equal(exhaustedHookCalls, 0, "Hook must not be invoked when resolver is skipped due to budget exhaustion");

    // R03R09-R01 fixture A: helper entry 100ms -> resolver loop sees 80ms remaining -> 0 OS inspect calls
    let r01ClockA = 1000;
    let r01InspectCallsA = 0;
    let r01HookCallsA = 0;
    await startAntigravitySessionPresenceAndRelay(
      {
        hook_event_name: "SessionStart",
        session_id: TEST_SESSION_ID,
        workspace_id: tmpDir,
      },
      {
        remainingBudgetMs: () => 100,
        now: () => {
          const cur = r01ClockA;
          // First `now()` sets `deadline = 1000 + 100 = 1100`; second `now()` inside loop is 1020 -> remaining = 80ms (< 100ms)
          r01ClockA += 20;
          return cur;
        },
        pidResolverOptions: {
          inspectProcess: () => {
            r01InspectCallsA += 1;
            return {
              pid: 41804,
              parentPid: 100,
              name: "Antigravity.exe",
              command: "C:\\Program Files\\Antigravity\\Antigravity.exe",
              startToken: "2026-10-22T00:00:00.000Z",
            };
          },
        },
        sessionMessageHook: async (_input, _host, pid) => {
          r01HookCallsA += 1;
          assert.equal(pid, undefined, "When loop remaining < 100ms skips OS query, explicitHostPid must be undefined");
          return {};
        },
      },
    );
    assert.equal(r01InspectCallsA, 0, "R03R09-R01: helper 100ms -> loop 80ms must not issue an OS inspect call");
    assert.equal(r01HookCallsA, 0, "Unverified observation after budget exhaustion must not invoke the hook");

    // R03R09-R01 fixture B: first ancestor gets 150ms, second ancestor has 80ms remaining -> stops after 1st ancestor
    let r01ClockB = 2000;
    const r01ObservedTimeoutsB = [];
    const r01ResultB = resolveLongLivedHostProcess(5001, "win32", {
      timeoutMs: 150,
      now: () => r01ClockB,
      inspectProcess: (pid, _platform, stepTimeoutMs) => {
        r01ObservedTimeoutsB.push(stepTimeoutMs);
        // Simulate 70ms elapsed during first OS query -> remaining drops from 150ms to 80ms (< 100ms)
        r01ClockB += 70;
        if (pid === 5001) {
          return {
            pid: 5001,
            parentPid: 41804,
            name: "cmd.exe",
            command: "C:\\Windows\\System32\\cmd.exe",
            startToken: "2026-10-22T00:00:01.000Z",
          };
        }
        return {
          pid: 41804,
          parentPid: 100,
          name: "Antigravity.exe",
          command: "C:\\Program Files\\Antigravity\\Antigravity.exe",
          startToken: "2026-10-22T00:00:00.000Z",
        };
      },
    });
    assert.equal(r01ResultB, null, "R03R09-R01: second ancestor with 80ms remaining must abort and return null");
    assert.deepEqual(
      r01ObservedTimeoutsB,
      [150],
      "R03R09-R01: first ancestor receives exact 150ms budget and second ancestor (80ms) is never queried",
    );

    // (g) #3317 M1 & R10-F03 (bc631ee6): On SessionStart (invoked without unsupported `--hook=session-init` and using
    // the supported `stageRunner` injection boundary without inventing new product options), even when `out` is non-empty
    // because `continuity` / `session-board` stages emitted `additionalContext`, if the `session-message` stage left
    // `claimTracker` in `claim-result-unknown`, `finalizeConnectorOutput` must still emit the default secret-free stderr
    // diagnostic line WITHOUT requiring `AGS_ANTIGRAVITY_DIAGNOSTIC_STDERR === "1"`. Conversely, when `after-claim-before-output`
    // transitions to `stdout-written-not-consumed` on non-empty `out`, default stderr remains silent unless `env=1`.
    const trackerM1Unknown = createClaimStateTracker();
    const seenStagesM1 = [];
    const outM1Unknown = await runConnectorFromRaw(
      JSON.stringify({
        conversationId: TEST_SESSION_ID,
        workspacePath: tmpDir,
      }),
      ["node", runnerPath, "--event=SessionStart"],
      {
        now: () => 1000,
        entryMonotonicMs: 1000,
        totalBudgetMs: 9200,
        postClaimReserveMs: 1000,
        claimTracker: trackerM1Unknown,
        stageRunner: async (stage, _event, _rawInput, currentToolInput, stageOptions) => {
          seenStagesM1.push(stage);
          if (stage === "session-message") {
            stageOptions.onClaimState({ phase: "request-attempted", messageIds: [] });
            return { output: {}, updatedToolInput: currentToolInput, mutated: false };
          }
          if (stage === "continuity") {
            return {
              output: { hookSpecificOutput: { additionalContext: "Continuity context restored." } },
              updatedToolInput: currentToolInput,
              mutated: false,
            };
          }
          if (stage === "session-board") {
            return {
              output: { hookSpecificOutput: { additionalContext: "[Session Board] 1 active session." } },
              updatedToolInput: currentToolInput,
              mutated: false,
            };
          }
          return { output: {}, updatedToolInput: currentToolInput, mutated: false };
        },
      },
    );
    assert.deepEqual(seenStagesM1, ["session-message", "continuity", "session-board"]);
    assert.equal(outM1Unknown.length > 0, true, "SessionStart with continuity/session-board output must produce non-empty out");
    assert.equal(trackerM1Unknown.getSnapshot().state, "claim-result-unknown");

    const stdoutChunksM1 = [];
    const stderrLinesM1 = [];
    finalizeConnectorOutput(outM1Unknown, trackerM1Unknown, {
      env: {},
      writeStdout: (text, cb) => {
        stdoutChunksM1.push(text);
        if (typeof cb === "function") cb();
      },
      writeStderr: (line) => stderrLinesM1.push(line),
    });
    assert.equal(stdoutChunksM1.length, 1);
    assert.equal(
      trackerM1Unknown.getSnapshot().state,
      "claim-result-unknown",
      "markStdoutWritten must not overwrite claim-result-unknown",
    );
    assert.equal(
      stderrLinesM1.length,
      1,
      "#3317 M1: non-empty out with claim-result-unknown must still emit default stderr diagnostic without env=1",
    );
    assert.deepEqual(JSON.parse(stderrLinesM1[0]), {
      agsAntigravityHookDiagnostic: {
        claimState: "claim-result-unknown",
        messageCount: 0,
        reentered: false,
        observerError: false,
        hostConsumedConfirmed: false,
      },
    });

    // Verify normal non-empty output after `response-received` transitions to `stdout-written-not-consumed` and stays silent by default
    const trackerM1Received = createClaimStateTracker();
    trackerM1Received.onClaimState({ phase: "request-attempted", messageIds: [] });
    trackerM1Received.onClaimState({ phase: "response-received", messageIds: ["msg-m1-ok"] });
    const stderrLinesM1Normal = [];
    finalizeConnectorOutput(outM1Unknown, trackerM1Received, {
      env: {},
      writeStdout: (_text, cb) => {
        if (typeof cb === "function") cb();
      },
      writeStderr: (line) => stderrLinesM1Normal.push(line),
    });
    assert.equal(trackerM1Received.getSnapshot().state, "stdout-written-not-consumed");
    assert.equal(stderrLinesM1Normal.length, 0, "Normal stdout-written-not-consumed must not emit stderr without env=1");

    // (h) R03R09-F01 & R10-R01 (7f008c42 & bc631ee6): Async `externalObserver` returning a rejected Promise (or custom
    // rejecting thenable) must be absorbed non-blockingly (`observerError = true`) without stalling execution budget /
    // cleanup, without causing an unhandledRejection, and without replaying the claim. Pin `now: () => 1000` alongside
    // `entryMonotonicMs: 1000` so the Stop `MIN_PRIMARY_HOOK_BUDGET_MS` (500ms) guard is 100% deterministic.
    let asyncClaimAttempts = 0;
    const trackerAsyncReject = createClaimStateTracker(async () => {
      throw new Error("Simulated async externalObserver rejection");
    });
    await executeAntigravityHookEvent(
      {
        conversationId: TEST_SESSION_ID,
        executionNum: 1,
        fullyIdle: true,
      },
      "Stop",
      "session-message",
      {
        now: () => 1000,
        entryMonotonicMs: 1000,
        totalBudgetMs: 9200,
        postClaimReserveMs: 1000,
        claimTracker: trackerAsyncReject,
        resolveHostProcess: () => null,
        sessionMessageHook: async (_input, _host, _pid, hookOptions) => {
          asyncClaimAttempts += 1;
          hookOptions.onClaimState({ phase: "request-attempted", messageIds: [] });
          hookOptions.onClaimState({ phase: "response-received", messageIds: ["msg-async-obs-001"] });
          return { hookSpecificOutput: { additionalContext: "[Session Messages] msg-async-obs-001" } };
        },
      },
    );
    // Allow microtask queue to flush the absorbed Promise rejection handler
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(asyncClaimAttempts, 1, "Async observer rejection must never replay claim");
    assert.deepEqual(trackerAsyncReject.getSnapshot(), {
      state: "after-claim-before-output",
      messageIds: ["msg-async-obs-001"],
      reentered: false,
      observerError: true,
      hostConsumedConfirmed: false,
    });

    // Also verify custom rejecting thenable without awaiting completion on the caller path
    const trackerThenableReject = createClaimStateTracker(() => ({
      then(_resolve, reject) {
        Promise.resolve().then(() => reject(new Error("Simulated custom thenable rejection")));
      },
    }));
    trackerThenableReject.onClaimState({ phase: "request-attempted", messageIds: [] });
    // Drain thenable assimilation and its rejection handler before observing.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(trackerThenableReject.getSnapshot().state, "claim-result-unknown");
    assert.equal(trackerThenableReject.getSnapshot().observerError, true);

    // (i) R03R09-F02 & R10-F02 (7f008c42 & bc631ee6):
    // Verify all 5 stdout completion/failure lifecycles on `finalizeConnectorOutput`:
    // 1. Canonical Node Writable failure order `callback(error) -> stream "error" event` (`@types/node/stream.d.ts:864-868`):
    //    must keep `"error"` listener alive across `callback(error)` so the subsequent `"error"` event is consumed
    //    (0 unhandled error events), clean up listener after `"error"` event (0 residual listeners), keep state at
    //    `after-claim-before-output`, and emit diagnostic exactly once.
    // 2. Clean `callback(null)` completion: transitions to `stdout-written-not-consumed`, removes `"error"` listener
    //    immediately (0 residual listeners), and emits 0 default diagnostics.
    // 3. Reverse `stream "error" event -> callback(null)` order: preserves `after-claim-before-output`, emits diagnostic
    //    once, removes listener (0 residual listeners), and ignores late callback.
    // 4. Synchronous throw inside `writeStdout`: preserves `after-claim-before-output`, cleans up `"error"` listener
    //    immediately (0 residual listeners), and emits diagnostic once.
    // 5. Duplicate callback invocation (`cb(err)` or `cb(null)` called twice): settles once and emits at most 1 diagnostic.
    function createMockStdoutStream(writeBehavior) {
      const errorListeners = [];
      let unhandledStreamErrors = 0;
      return {
        getErrorListenerCount: () => errorListeners.length,
        getUnhandledErrorCount: () => unhandledStreamErrors,
        once(ev, fn) {
          if (ev === "error" && typeof fn === "function") {
            const wrapper = (err) => {
              const idx = errorListeners.indexOf(wrapper);
              if (idx >= 0) errorListeners.splice(idx, 1);
              fn(err);
            };
            wrapper._orig = fn;
            errorListeners.push(wrapper);
          }
        },
        removeListener(ev, fn) {
          if (ev === "error") {
            const idx = errorListeners.findIndex((w) => w === fn || w._orig === fn);
            if (idx >= 0) errorListeners.splice(idx, 1);
          }
        },
        emitError(err) {
          if (errorListeners.length === 0) {
            unhandledStreamErrors += 1;
            return;
          }
          const snapshot = [...errorListeners];
          for (const listener of snapshot) {
            listener(err);
          }
        },
        write(text, cb) {
          writeBehavior(this, text, cb);
        },
      };
    }

    // Case 1: Canonical `callback(EPIPE) -> stream "error"(EPIPE)` order
    const trackerCbThenErr = createClaimStateTracker();
    trackerCbThenErr.onClaimState({ phase: "request-attempted", messageIds: [] });
    trackerCbThenErr.onClaimState({ phase: "response-received", messageIds: ["msg-epipe-001"] });
    const stderrCbThenErr = [];
    let listenerCountAfterCb = -1;
    const streamCbThenErr = createMockStdoutStream((stream, _text, cb) => {
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      if (typeof cb === "function") cb(epipe);
      listenerCountAfterCb = stream.getErrorListenerCount();
      stream.emitError(epipe);
    });
    finalizeConnectorOutput('{"systemMessage":"[Session Messages] msg-epipe-001"}', trackerCbThenErr, {
      env: {},
      stdoutStream: streamCbThenErr,
      writeStderr: (line) => stderrCbThenErr.push(line),
    });
    assert.equal(listenerCountAfterCb, 1, "R10-F02: error listener must remain registered after callback(error) until stream error fires");
    assert.equal(streamCbThenErr.getUnhandledErrorCount(), 0, "R10-F02: subsequent stream error event must be consumed without unhandled error");
    assert.equal(streamCbThenErr.getErrorListenerCount(), 0, "R10-F02: error listener must be cleaned up after consuming stream error");
    assert.equal(trackerCbThenErr.getSnapshot().state, "after-claim-before-output");
    assert.equal(stderrCbThenErr.length, 1);
    assert.deepEqual(JSON.parse(stderrCbThenErr[0]), {
      agsAntigravityHookDiagnostic: {
        claimState: "after-claim-before-output",
        messageCount: 1,
        reentered: false,
        observerError: false,
        hostConsumedConfirmed: false,
      },
    });

    // Case 2: Clean `callback(null)` completion cleans up stream error listener immediately
    const trackerCleanStream = createClaimStateTracker();
    trackerCleanStream.onClaimState({ phase: "request-attempted", messageIds: [] });
    trackerCleanStream.onClaimState({ phase: "response-received", messageIds: ["msg-clean-001"] });
    const stderrCleanStream = [];
    const streamClean = createMockStdoutStream((_stream, _text, cb) => {
      if (typeof cb === "function") cb(null);
    });
    finalizeConnectorOutput('{"systemMessage":"[Session Messages] msg-clean-001"}', trackerCleanStream, {
      env: {},
      stdoutStream: streamClean,
      writeStderr: (line) => stderrCleanStream.push(line),
    });
    assert.equal(trackerCleanStream.getSnapshot().state, "stdout-written-not-consumed");
    assert.equal(streamClean.getErrorListenerCount(), 0, "Clean write completion must remove stream error listener immediately");
    assert.equal(stderrCleanStream.length, 0);

    // Case 3: `stream "error" -> callback(null)` order
    const trackerErrThenCb = createClaimStateTracker();
    trackerErrThenCb.onClaimState({ phase: "request-attempted", messageIds: [] });
    trackerErrThenCb.onClaimState({ phase: "response-received", messageIds: ["msg-stream-err-001"] });
    const stderrErrThenCb = [];
    const streamErrThenCb = createMockStdoutStream((stream, _text, cb) => {
      stream.emitError(Object.assign(new Error("stream EPIPE"), { code: "EPIPE" }));
      if (typeof cb === "function") cb(null);
    });
    finalizeConnectorOutput('{"systemMessage":"[Session Messages] msg-stream-err-001"}', trackerErrThenCb, {
      env: {},
      stdoutStream: streamErrThenCb,
      writeStderr: (line) => stderrErrThenCb.push(line),
    });
    assert.equal(trackerErrThenCb.getSnapshot().state, "after-claim-before-output");
    assert.equal(streamErrThenCb.getUnhandledErrorCount(), 0);
    assert.equal(streamErrThenCb.getErrorListenerCount(), 0);
    assert.equal(stderrErrThenCb.length, 1);

    // Case 4: Synchronous throw inside `write` cleans up stream error listener immediately
    const trackerSyncThrow = createClaimStateTracker();
    trackerSyncThrow.onClaimState({ phase: "request-attempted", messageIds: [] });
    trackerSyncThrow.onClaimState({ phase: "response-received", messageIds: ["msg-sync-throw-001"] });
    const stderrSyncThrow = [];
    const streamSyncThrow = createMockStdoutStream(() => {
      throw new Error("synchronous stdout write failure");
    });
    finalizeConnectorOutput('{"systemMessage":"[Session Messages] msg-sync-throw-001"}', trackerSyncThrow, {
      env: {},
      stdoutStream: streamSyncThrow,
      writeStderr: (line) => stderrSyncThrow.push(line),
    });
    assert.equal(trackerSyncThrow.getSnapshot().state, "after-claim-before-output");
    assert.equal(streamSyncThrow.getErrorListenerCount(), 0, "Sync write throw must clean up stream error listener immediately");
    assert.equal(stderrSyncThrow.length, 1);

    // Case 5: Duplicate callback invocation (`cb(err)` followed by duplicate `cb(null)`)
    const trackerDupCb = createClaimStateTracker();
    trackerDupCb.onClaimState({ phase: "request-attempted", messageIds: [] });
    trackerDupCb.onClaimState({ phase: "response-received", messageIds: ["msg-dup-cb-001"] });
    const stderrDupCb = [];
    finalizeConnectorOutput('{"systemMessage":"[Session Messages] msg-dup-cb-001"}', trackerDupCb, {
      env: {},
      writeStdout: (_text, cb) => {
        if (typeof cb === "function") {
          cb(new Error("first callback error"));
          cb(null);
        }
      },
      writeStderr: (line) => stderrDupCb.push(line),
    });
    assert.equal(trackerDupCb.getSnapshot().state, "after-claim-before-output");
    assert.equal(stderrDupCb.length, 1, "Duplicate callback must not emit duplicate diagnostics or promote state");
  }

  // 14. [AGS-D-0015]: Resolve missing Antigravity wake runtime environment (ANTIGRAVITY_PROJECT_ID,
  // ANTIGRAVITY_AGENTAPI_EXE, ANTIGRAVITY_LS_ADDRESS, ANTIGRAVITY_CSRF_TOKEN) from verified host process
  // commandLine, local project registry, and host log before spawning the detached relay.
  {
    const wakeFixtureDir = mkdtempSync(path.join(tmpDir, "wake-env-"));
    const workspaceDir = path.join(wakeFixtureDir, "workspace");
    const projectsDir = path.join(wakeFixtureDir, ".gemini", "config", "projects");
    const binDir = path.join(wakeFixtureDir, ".gemini", "antigravity", "bin");
    const logPath = path.join(wakeFixtureDir, "language_server.log");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const fakeLsExe = path.join(binDir, process.platform === "win32" ? "language_server_windows_x64.exe" : "language_server_linux_x64");
    writeFileSync(fakeLsExe, "binary-stub", "utf8");
    writeFileSync(
      path.join(projectsDir, "project-1.json"),
      JSON.stringify({
        id: "resolved-project-uuid",
        projectResources: { resources: [{ folderUri: pathToFileURL(workspaceDir).href }] },
      }),
      "utf8",
    );
    writeFileSync(
      logPath,
      [
        "I1027 00:00:01.000000 100 main.go:1] Starting language server process with pid 41804",
        "I1027 00:00:01.100000 100 server.go:2] Language server listening on random port at 58034 for HTTP",
      ].join("\n"),
      "utf8",
    );

    const trustedFakeLsExe = process.platform === "win32"
      ? "C:\\Program Files\\Antigravity\\language_server_windows_x64.exe"
      : "/opt/antigravity/bin/language_server_linux_x64";
    const resolvedHost = resolveLongLivedHostProcess(41804, process.platform, {
      inspectProcess: (pid) => pid === 41804
        ? {
            pid: 41804,
            parentPid: 1,
            name: path.win32.basename(trustedFakeLsExe),
            command: trustedFakeLsExe,
            commandLine: `"${trustedFakeLsExe}" --csrf_token=test-csrf-token-0015 --random_port`,
            startToken: "2026-10-27T00:00:00.000Z",
          }
        : null,
    });
    assert.deepEqual(resolvedHost, { pid: 41804, startToken: "2026-10-27T00:00:00.000Z" });

    const envWithoutConfiguredExe = {};
    const prevProcessCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    const resolvedEnv = resolveAntigravityWakeEnvironment(
      { workspace_id: workspaceDir, cwd: workspaceDir },
      resolvedHost,
      {
        env: envWithoutConfiguredExe,
        homeDir: wakeFixtureDir,
        projectsDir,
        logFilePath: logPath,
      },
    );
    assert.equal(resolvedEnv.ANTIGRAVITY_PROJECT_ID, "resolved-project-uuid");
    assert.equal(resolvedEnv.ANTIGRAVITY_CSRF_TOKEN, "test-csrf-token-0015");
    assert.equal(resolvedEnv.ANTIGRAVITY_LS_ADDRESS, "localhost:58034");
    assert.deepEqual(envWithoutConfiguredExe, {}, "options.env must never be mutated with CSRF tokens or wake variables");
    assert.equal(process.env.ANTIGRAVITY_CSRF_TOKEN, prevProcessCsrf, "process.env must never be mutated with CSRF tokens");

    // Verify large language_server.log (> 128KB) where "Listening on port <port> for HTTP JSON and Connect RPC"
    // appears only at the very beginning (Head) and is pushed out of the last 64KB (Tail) by subsequent log lines.
    const largeLogPath = path.join(wakeFixtureDir, "large_language_server.log");
    writeFileSync(
      largeLogPath,
      `I1028 00:00:00.000000 41804 server.go:10] Listening on port 51234 for HTTP JSON and Connect RPC\n${"x".repeat(160 * 1024)}\n`,
      "utf8",
    );
    const largeLogEnv = resolveAntigravityWakeEnvironment(
      { workspace_id: workspaceDir, cwd: workspaceDir },
      resolvedHost,
      {
        env: {},
        homeDir: wakeFixtureDir,
        projectsDir,
        logFilePath: largeLogPath,
      },
    );
    assert.equal(largeLogEnv.ANTIGRAVITY_LS_ADDRESS, "localhost:51234");

    // Verify startAntigravitySessionPresenceAndRelay passes relayEnv via hookOptions without mutating process.env or options.env
    const capturedHookOptions = [];
    await startAntigravitySessionPresenceAndRelay(
      { hook_event_name: "SessionStart", session_id: TEST_SESSION_ID, workspace_id: workspaceDir, cwd: workspaceDir },
      {
        now: () => 1000,
        deadlineMonotonicMs: 10200,
        env: envWithoutConfiguredExe,
        homeDir: wakeFixtureDir,
        projectsDir,
        logFilePath: logPath,
        resolveHostProcess: () => resolvedHost,
        sessionMessageHook: async (_input, _host, _pid, hookOptions) => {
          capturedHookOptions.push(hookOptions);
          return {};
        },
      },
    );
    assert.equal(capturedHookOptions.length, 1);
    assert.equal(capturedHookOptions[0].relayEnv?.ANTIGRAVITY_PROJECT_ID, "resolved-project-uuid");
    assert.equal(capturedHookOptions[0].relayEnv?.ANTIGRAVITY_CSRF_TOKEN, "test-csrf-token-0015");
    assert.equal(capturedHookOptions[0].relayEnv?.ANTIGRAVITY_LS_ADDRESS, "localhost:58034");
    assert.deepEqual(envWithoutConfiguredExe, {});

    // Passing options.env alone without verified host detail or explicit discovery targets must not trigger wake discovery
    const envOnlyOptions = [];
    await startAntigravitySessionPresenceAndRelay(
      { hook_event_name: "SessionStart", session_id: TEST_SESSION_ID, workspace_id: workspaceDir },
      {
        now: () => 1000,
        deadlineMonotonicMs: 10200,
        env: { SOME_OTHER_VAR: "1" },
        resolveHostProcess: () => ({ pid: 41804, startToken: "2026-10-27T00:00:00.000Z" }),
        sessionMessageHook: async (_input, _host, _pid, hookOptions) => {
          envOnlyOptions.push(hookOptions);
          return {};
        },
      },
    );
    assert.equal(envOnlyOptions.length, 1);
    assert.equal(envOnlyOptions[0].relayEnv, undefined);

    // Verify diagnostic reason codes when files/patterns are missing or malformed (never swallowing errors or leaking secrets)
    const missingDiagEnv = resolveAntigravityWakeEnvironment(
      { workspace_id: workspaceDir, cwd: workspaceDir },
      { pid: 41804, startToken: "2026-10-27T00:00:00.000Z", command: "", commandLine: "" },
      {
        env: {},
        platform: "win32",
        homeDir: path.join(wakeFixtureDir, "nonexistent-home"),
        projectsDir: path.join(wakeFixtureDir, "nonexistent-projects"),
        logFilePath: path.join(wakeFixtureDir, "nonexistent.log"),
      },
    );
    assert.equal(
      missingDiagEnv.ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC,
      "AGENTAPI_SHIM_MISSING,CSRF_TOKEN_NOT_FOUND,LS_LOG_READ_FAILED,PROJECTS_DIR_READ_FAILED",
    );

    const badShimPath = path.join(wakeFixtureDir, "bad-agentapi.bat");
    const badLogPath = path.join(wakeFixtureDir, "no-port.log");
    const badProjectsDir = path.join(wakeFixtureDir, "bad-projects");
    mkdirSync(badProjectsDir, { recursive: true });
    writeFileSync(badShimPath, "@echo off\r\necho invalid-shim\r\n", "utf8");
    writeFileSync(badLogPath, "Starting language server process with pid 41804\nno port line here\n", "utf8");
    writeFileSync(path.join(badProjectsDir, "broken.json"), "{not-valid-json", "utf8");
    const parseDiagEnv = resolveAntigravityWakeEnvironment(
      { workspace_id: workspaceDir, cwd: workspaceDir },
      { pid: 41804, startToken: "2026-10-27T00:00:00.000Z", command: "", commandLine: "--other_flag=secret-value" },
      {
        env: {},
        platform: "win32",
        agentApiShimPath: badShimPath,
        projectsDir: badProjectsDir,
        logFilePath: badLogPath,
      },
    );
    assert.equal(
      parseDiagEnv.ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC,
      "AGENTAPI_SHIM_FORMAT_UNRECOGNIZED,CSRF_TOKEN_NOT_FOUND,LS_LOG_PORT_PATTERN_NOT_FOUND,PROJECT_JSON_PARSE_FAILED",
    );
    assert.equal(parseDiagEnv.ANTIGRAVITY_WAKE_ENV_DIAGNOSTIC.includes("secret-value"), false);
  }

  // 15. [AGS-D-0320]: SessionStart, PreInvocation, and PostInvocation inject persistent nested
  // systemMessage steps ({ systemMessage: { systemMessage: ... } }) instead of transient ephemeralMessage
  // steps so claimed peer messages survive across planner steps and turns in the trajectory.
  {
    const peerEnvelope = "[agent-governance-suite peer message BEGIN]\n{\"message\":\"persist-across-turns\"}\n[agent-governance-suite peer message END]";
    for (const ev of ["SessionStart", "PreInvocation", "PostInvocation"]) {
      const translated = translateCanonicalOutputToAntigravity(
        ev,
        { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: peerEnvelope } },
        null,
      );
      assert.deepEqual(translated, {
        injectSteps: [{ systemMessage: { systemMessage: peerEnvelope } }],
      });
      assert.equal(Object.hasOwn(translated.injectSteps[0], "ephemeralMessage"), false);
    }

    for (const ev of ["PreInvocation", "PostInvocation"]) {
      const rawOut = await runConnectorFromRaw(
        JSON.stringify({ conversationId: TEST_SESSION_ID, workspacePaths: [tmpDir] }),
        ["node", runnerPath, `--event=${ev}`, "--hook=session-message"],
        {
          resolveHostProcess: () => null,
          sessionMessageHook: async () => ({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: peerEnvelope,
            },
          }),
        },
      );
      const parsed = JSON.parse(rawOut);
      assert.deepEqual(parsed, {
        injectSteps: [{ systemMessage: { systemMessage: peerEnvelope } }],
      });
      assert.equal(Object.hasOwn(parsed.injectSteps[0], "ephemeralMessage"), false);
    }
  }

  // 16. [AGS-D-0011]: startAntigravitySessionPresenceAndRelay reports inspection/startup failures via
  // onInspectionFailure (and onProcessIdentityFailure) without swallowing them silently or leaking private secrets.
  {
    const observedFailures = [];
    const secretError = new Error("PRIVATE_SECRET_HOOK_FAILURE_0011");
    await startAntigravitySessionPresenceAndRelay(
      { hook_event_name: "SessionStart", session_id: TEST_SESSION_ID, workspace_id: tmpDir },
      {
        now: () => 1000,
        deadlineMonotonicMs: 10200,
        resolveHostProcess: () => ({ pid: 41804, startToken: "2026-10-27T00:00:00.000Z" }),
        sessionMessageHook: async () => {
          throw secretError;
        },
        onInspectionFailure: (failure) => {
          observedFailures.push(failure);
        },
      },
    );
    assert.equal(observedFailures.length, 1);
    assert.equal(observedFailures[0].code, "HOST_PROCESS_INSPECTION_FAILED");
    assert.equal(observedFailures[0].cause, secretError);
  }

  console.log("antigravity-hook-runner tests: 16/16 passed");
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
}, 30_000);
