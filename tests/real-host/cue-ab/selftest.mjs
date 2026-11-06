// Local check of the judge with made-up transcripts (no host, no model): node selftest.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgeRun } from "./check.mjs";

const known = new Set(["ponytail", "test-engineering", "blocker-diagnostician", "code-review", "prompt-engineering", "mutation-risk-preflight", "orchestrator"]);
const lines = (events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const dir = mkdtempSync(path.join(tmpdir(), "cue-ab-selftest-"));

function run(name, host, turnLogs, meta) {
  const runDir = path.join(dir, name);
  mkdirSync(runDir);
  writeFileSync(path.join(runDir, "turns.jsonl"), lines(meta));
  for (const [n, events] of Object.entries(turnLogs)) writeFileSync(path.join(runDir, `turn-${n}.jsonl`), lines(events));
  return judgeRun(host, runDir, known);
}

const claudeSkill = (id, skill, extra = {}) => ({ type: "assistant", ...extra, message: { content: [{ type: "tool_use", id, name: "Skill", input: { skill } }] } });
const claudeText = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const claudeResult = { type: "result", subtype: "success", is_error: false };
const ok = (turn) => ({ turn, exit: 0, seconds: 10 });

try {
  const claude = run("claude", "claude", {
    1: [claudeSkill("t1", "agent-governance-suite:ponytail"), claudeText("I could also use test-engineering"), claudeResult],
    2: [claudeText("done, no skill"), claudeResult],
    3: [claudeSkill("t3", "agent-governance-suite:ponytail"), claudeResult],
    4: [claudeSkill("t4", "agent-governance-suite:blocker-diagnostician"), claudeSkill("t4b", "agent-governance-suite:code-review"), claudeResult],
    5: [claudeSkill("t1", "agent-governance-suite:code-review"), claudeResult],
    6: [claudeSkill("t6", "some-user-skill"), claudeSkill("t6b", "agent-governance-suite:prompt-engineering")],
  }, [ok(1), ok(2), ok(3), ok(4), ok(5), { turn: 6, exit: 124, seconds: 600 }, { turn: 7, skipped: true, reason: "test" }]);
  assert.deepEqual(claude.turns.map((turn) => turn.verdict), ["hit", "miss", "over", "hit+over", "miss", "timeout", "skipped"]);
  assert.deepEqual(claude.turns[0].calls, ["ponytail"]);
  assert.deepEqual(claude.turns[3].overCalls, ["code-review"]);
  assert.deepEqual(claude.turns[5].foreign, ["some-user-skill"]);
  assert.deepEqual(claude.turns[5].calls, ["prompt-engineering"]);
  assert.deepEqual(claude.totals, { specialistTurns: 6, hits: 2, controlTurns: 1, controlClean: 0, overCallTurns: 2, overCallNames: 2, strictExtraNames: 2, failedTurns: 2 });

  const command = (item) => ({ type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 0, ...item } });
  const codexDone = [{ type: "turn.completed" }];
  const codex = run("codex", "codex", {
    1: [{ type: "thread.started", thread_id: "th-1" }, command({ command: "/bin/bash -lc \"sed -n '1,80p' /h/.codex/plugins/cache/x/agent-governance-suite/3.8.0/skills/ponytail/SKILL.md\"" }), ...codexDone],
    2: [command({ command: "ls /h/skills/test-engineering/SKILL.md" }), ...codexDone],
    3: [{ type: "item.completed", item: { type: "agent_message", text: "cat /h/skills/ponytail/SKILL.md" } }, ...codexDone],
    4: [command({ command: "cat /h/skills/blocker-diagnostician/SKILL.md", exit_code: 1 }), ...codexDone],
    5: [command({ command: "cat /h/skills/code-review/SKILL.md /h/skills/orchestrator/SKILL.md" }), ...codexDone],
    6: [command({ command: "cat /h/skills/prompt-engineering/SKILL.md /h/skills/mutation-risk-preflight/SKILL.md" }), ...codexDone],
  }, [ok(1), ok(2), ok(3), ok(4), ok(5), ok(6), { turn: 7, exit: 1, seconds: 3 }]);
  assert.deepEqual(codex.turns.map((turn) => turn.verdict), ["hit", "miss", "ok", "miss", "hit", "hit+over", "error"]);
  assert.deepEqual(codex.turns[1].weak, ["test-engineering"]);
  assert.deepEqual(codex.turns[3].weak, ["blocker-diagnostician"]);
  assert.deepEqual(codex.turns[4].calls.sort(), ["code-review", "orchestrator"]);
  assert.deepEqual(codex.turns[4].overCalls, []);
  assert.equal(codex.totals.hits, 3);
  console.log("selftest ok: claude", claude.turns.map((turn) => turn.verdict).join(","), "| codex", codex.turns.map((turn) => turn.verdict).join(","));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
