// Usage: node hook-runner.mjs <codex|claude> <pluginRoot> <home>
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const [host, root, home] = process.argv.slice(2);
const hooks = JSON.parse(readFileSync(path.join(root, "hooks/hooks.json"), "utf8")).hooks;
const cwd = "/tmp/work-" + host; mkdirSync(cwd, { recursive: true });
const transcript = path.join(home, "transcript.jsonl"); writeFileSync(transcript, "");
const prefix = host === "codex" ? "mcp__agent_governance_suite__" : "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const sid = host + "-probe-session-0001";
const base = { session_id: sid, cwd, transcript_path: transcript, turn_id: "turn-1", model: host === "codex" ? "gpt-5.5" : "claude-opus-4-8" };
// representative tool name per matcher
const toolSamples = ["plan_workflow", "prepare_session_message", "open_convergence_root", "update_session_status"].map((t) => prefix + t).concat(["Bash", "exec_command", "Edit"]);
const samplesFor = (event, matcher) => {
  const re = matcher ? new RegExp(matcher) : null;
  const pick = (vals) => { const v = re ? vals.filter((x) => re.test(x)) : vals.slice(0, 1); return v.length ? v : [vals[0]]; };
  switch (event) {
    case "SessionStart": return pick(["startup"]).map((source) => ({ ...base, hook_event_name: event, source }));
    case "SessionEnd": return [{ ...base, hook_event_name: event, reason: "exit" }];
    case "UserPromptSubmit": return [{ ...base, hook_event_name: event, prompt: "install-tree probe prompt" }];
    case "PreCompact": case "PostCompact": return pick(["auto"]).map((trigger) => ({ ...base, hook_event_name: event, trigger }));
    case "PreToolUse": case "PostToolUse": {
      const names = re ? toolSamples.filter((x) => re.test(x)).slice(0, 1) : [prefix + "list_session_status"];
      return names.map((tool_name) => ({ ...base, hook_event_name: event, tool_name, tool_use_id: "toolu_probe", tool_input: tool_name.endsWith("update_session_status") ? { schemaVersion: "1.0.0", summary: "probe" } : { command: "echo hi" }, ...(event === "PostToolUse" ? { tool_response: { ok: true } } : {}) }));
    }
    case "PostModelSwitch": return [{ ...base, hook_event_name: event, from_model: "claude-sonnet-5", to_model: "claude-opus-4-8" }];
    case "Stop": return [{ ...base, hook_event_name: event, stop_hook_active: false }];
    default: return [{ ...base, hook_event_name: event }];
  }
};
const env = { PATH: process.env.PATH, HOME: home };
if (host === "codex") env.PLUGIN_ROOT = root; else { env.CLAUDE_PLUGIN_ROOT = root; env.CLAUDE_PLUGIN_DATA = path.join(home, "plugin-data"); mkdirSync(env.CLAUDE_PLUGIN_DATA, { recursive: true }); }
const results = [];
for (const [event, groups] of Object.entries(hooks)) {
  groups.forEach((group, gi) => {
    for (const h of group.hooks) {
      for (const input of samplesFor(event, group.matcher)) {
        let r, shown;
        if (host === "codex") { shown = h.command; r = spawnSync("bash", ["-c", h.command], { input: JSON.stringify(input), env, cwd, encoding: "utf8", timeout: (h.timeout ?? 30) * 1000 }); }
        else { const args = (h.args ?? []).map((a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", root)); shown = [h.command, ...args].join(" "); r = spawnSync(h.command, args, { input: JSON.stringify(input), env, cwd, encoding: "utf8", timeout: (h.timeout ?? 30) * 1000 }); }
        const rec = { event, group: gi, matcher: group.matcher ?? null, command: shown, input_tool: input.tool_name ?? input.source ?? input.trigger ?? null, exit: r.status, signal: r.signal, error: r.error?.message ?? null, stdout: r.stdout, stderr: r.stderr };
        results.push(rec);
        console.log(`--- ${event}[${gi}] matcher=${rec.matcher} sample=${rec.input_tool}\n$ ${shown}\nEXIT=${r.status} SIGNAL=${r.signal} ERR=${rec.error}\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
      }
    }
  });
}
const summary = results.map((r) => `${r.event}[${r.group}] ${path.basename((r.command.match(/[\w-]+\.mjs/) ?? ["?"])[0])} exit=${r.exit} stdout=${r.stdout.length}B stderr=${r.stderr.length}B${/Cannot find|ERR_MODULE_NOT_FOUND/.test(r.stderr) ? " MODULE_NOT_FOUND" : ""}`);
console.log("=== SUMMARY\n" + summary.join("\n"));
process.exitCode = results.some((r) => r.exit !== 0) ? 1 : 0;
