import { spawn } from "node:child_process";

// Claim worker whose failure mode is chosen by the test: "normal" reports and exits,
// "no-result" never answers the claim, "no-exit" reports but never exits, "hold-stdout" never answers and leaves
// a grandchild (gone within 60 s) holding its stdout pipe, so the worker cannot close even after it is killed (its pid goes to stdout).
const { mode } = JSON.parse(process.argv[2]!) as { mode: "normal" | "no-result" | "no-exit" | "hold-stdout" };

if (mode !== "normal") setInterval(() => {}, 1000);
if (mode === "hold-stdout") {
  // detached: on Windows a non-detached child joins this worker's kill-on-close job and would die with the
  // worker, closing the pipe the test needs held (CI 41264309723 Windows shard 1).
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: ["ignore", "inherit", "ignore"], detached: true, windowsHide: true });
  await new Promise(resolve => holder.once("spawn", resolve));
  process.stdout.write(`${JSON.stringify({ holderPid: holder.pid })}\n`);
}
process.send!({ type: "ready" });
process.once("message", () => {
  if (mode === "no-result" || mode === "hold-stdout") return;
  process.send!({ type: "result", result: { mode, pid: process.pid } }, () => { if (mode === "normal") process.disconnect!(); });
});
