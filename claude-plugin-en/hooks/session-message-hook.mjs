#!/usr/bin/env node
// Claude Code launcher for the shared TLS session-message hook bundle.
// Messaging is optional and must never block the host, but each launcher stage failure is
// reported with its stage and a bounded code (no message, path or input) instead of vanishing.
import { readFileSync, writeSync } from "node:fs";

const LAUNCHER = "session-message-hook";

// 공식 비동기 SessionStart 명령만 선택한다. 입력·본문·영수증 훅은 계속 동기로 실행한다.
let relayClosed;
function ownRelay(child) {
  relayClosed = new Promise((resolve) => {
    const stop = () => child.kill();
    process.once("exit", stop);
    child.once("close", () => {
      process.removeListener("exit", stop);
      resolve();
    });
  });
}

// One stderr format for every product diagnostic (AGS3-D-0023): the shared runtime writes the record; a package
// missing that module still reports the failed stage in the same one-line {component, event} format.
const diagnostics = await import("../runtime/diagnostic-record.mjs").catch(() => null);

/** Names the failed launcher stage with a bounded code; never messages, paths or input. */
function reportLauncherFailure(stage, cause, observed = {}) {
  if (diagnostics) {
    diagnostics.writeStageFailure(LAUNCHER, "launcher-failure", stage, cause, observed);
    return;
  }
  try { writeSync(2, `${JSON.stringify({ component: LAUNCHER, event: "launcher-failure", stage, reason: "DIAGNOSTIC_RUNTIME_UNAVAILABLE" })}\n`); }
  catch { /* A broken diagnostic sink cannot block the host. */ }
}

let stage = "stdin";
try {
  const raw = readFileSync(0, "utf8");
  stage = "import";
  const bundle = await import("../mcp-server/dist/session-message-hook.mjs");
  stage = "export";
  const run = bundle.runSessionMessageHookOutcome;
  if (typeof run !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
  stage = "run";
  const outcome = await run("claude-code", raw, undefined,
    process.argv.includes("--own-relay") ? { relayOwner: ownRelay } : {});
  stage = "outcome";
  if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean" || typeof outcome.output !== "string") {
    throw Object.assign(new Error("Launcher outcome is invalid."), { code: "LAUNCHER_OUTCOME_INVALID" });
  }
  // The bundle owns the failed phase/reason diagnostic; stdout and exit remain fail-open.
  if (outcome.ok && outcome.output) {
    stage = "stdout";
    process.stdout.on("error", (cause) => reportLauncherFailure("stdout", cause));
    process.stdout.write(outcome.output);
  }
} catch (cause) {
  reportLauncherFailure(stage, cause);
}

// 참조를 유지한 비분리 자식 덕분에 이 훅이 호스트의 검증된 프로세스 트리에 남는다.
// 공식 비동기 훅 취소가 그 트리를 회수하며, 정상 child close는 이 훅의 대기도 끝낸다.
if (relayClosed) await relayClosed;
