// Runs every turn of tasks.mjs in ONE Claude Code process (streaming input), so SessionStart fires once and
// UserPromptSubmit fires once per message, as in an interactive chat:
//   node claude-stream.mjs <runDir> <repoDir> <turnTimeoutSec> <claude args...>
// Writes <runDir>/turn-<n>.jsonl (the events between two `result` events) and <runDir>/turns.jsonl like run-one.sh does.
// `--resume` starts a new process per turn, and every such start fires SessionStart(source=resume); a candidate that
// puts the skill list into the session start would then send it with every turn. This mode avoids that.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import path from "node:path";
import { TURNS as DEFAULT_TURNS } from "./tasks.mjs";

const TURNS = process.env.CUE_TASKS_FILE ? JSON.parse(readFileSync(process.env.CUE_TASKS_FILE, "utf8")) : DEFAULT_TURNS;

const [runDir, repoDir, timeoutSec, ...claudeArgs] = process.argv.slice(2);
if (!runDir || !repoDir || !timeoutSec) throw new Error("usage: node claude-stream.mjs <runDir> <repoDir> <turnTimeoutSec> <claude args...>");
const bin = process.env.CLAUDE_BIN ?? "claude";
const command = bin.endsWith(".mjs") ? [process.execPath, bin] : [bin];
const errFd = openSync(path.join(runDir, "stream.err"), "a");
const child = spawn(command[0], [...command.slice(1), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...claudeArgs],
  { cwd: repoDir, stdio: ["pipe", "pipe", errFd], env: process.env });
const observedSessions = new Set();
const saveSession = () => writeFileSync(path.join(runDir, "session.json"), JSON.stringify({ hostPid: child.pid,
  transport: "claude-stream", observedSessionIds: [...observedSessions] }));
saveSession();

const rows = [];
let turn = 1;
let sentAt = Date.now();
let timer;
let finished = false;
const logFile = (n) => path.join(runDir, `turn-${n}.jsonl`);

function send(n) {
  sentAt = Date.now();
  child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: TURNS[n - 1].prompt } }) + "\n");
  timer = setTimeout(() => finish(124, "turn timeout"), Number(timeoutSec) * 1000);
}

function finish(exit, reason) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (exit !== 0) rows.push({ turn, exit, seconds: Math.round((Date.now() - sentAt) / 1000), reason });
  for (let n = turn + 1; n <= TURNS.length; n += 1) rows.push({ turn: n, skipped: true, reason: `turn ${turn} did not finish (${reason})` });
  writeFileSync(path.join(runDir, "turns.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  child.stdin.end();
  if (exit !== 0) child.kill("SIGTERM");
  closeSync(errFd);
  setTimeout(() => { child.kill("SIGTERM"); process.exit(exit === 0 ? 0 : 1); }, 1500);
}

createInterface({ input: child.stdout }).on("line", (line) => {
  if (finished) return;
  appendFileSync(logFile(turn), line + "\n");
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (typeof event.session_id === "string") { observedSessions.add(event.session_id); saveSession(); }
  if (event.type !== "result") return;
  clearTimeout(timer);
  if (event.is_error === true || (event.subtype && event.subtype !== "success")) { finish(1, "Claude result failed"); return; }
  rows.push({ turn, exit: 0, seconds: Math.round((Date.now() - sentAt) / 1000) });
  if (turn < TURNS.length) { turn += 1; send(turn); } else finish(0, "done");
});
child.on("close", (code) => finish(code === 0 || code === null ? 1 : code, "claude exited"));
child.on("error", () => finish(1, "Claude launch failed"));
child.stdin.on("error", () => finish(1, "Claude stdin failed"));
send(1);
