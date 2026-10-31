// Claim worker whose failure mode is chosen by the test: "normal" reports and exits,
// "no-result" never answers the claim, "no-exit" reports but never exits.
const { mode } = JSON.parse(process.argv[2]!) as { mode: "normal" | "no-result" | "no-exit" };

if (mode !== "normal") setInterval(() => {}, 1000);
process.send!({ type: "ready" });
process.once("message", () => {
  if (mode === "no-result") return;
  process.send!({ type: "result", result: { mode, pid: process.pid } }, () => { if (mode === "normal") process.disconnect!(); });
});
