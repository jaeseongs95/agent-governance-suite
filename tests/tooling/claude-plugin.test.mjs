import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyReplacements,
  applySkillAdaptation,
  DUAL_HOST_FILES,
  EXCLUDED_SKILLS,
  findCodexOnlyWording,
  mapSkillInvocations,
  OUTPUT_DIRECTORY,
  replaceFrontmatterDescription,
  reportClaudePluginDrift,
} from "../../scripts/build-claude-plugin.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pluginRoot = path.join(root, OUTPUT_DIRECTORY);
const toolPrefix = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const continuityTools = [
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context",
];
const temporaryDirectories = [];

async function readJson(...segments) {
  return JSON.parse(await readFile(path.join(...segments), "utf8"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function versionParts(version) {
  return version.split(".").map(Number);
}

function compareVersions(left, right) {
  const [a, b] = [versionParts(left), versionParts(right)];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

// Freshness against the shared sources is reported by `pnpm claude:drift` and
// enforced only by `pnpm claude:check`, so shared-source changes never fail here.
describe("generated Claude plugin", () => {
  it("uses a released version and plugin-scoped runtime paths", async () => {
    const release = await readJson(root, "release", "version.json");
    const manifest = await readJson(pluginRoot, ".claude-plugin", "plugin.json");
    expect(manifest.name).toBe("agent-governance-suite");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(compareVersions(manifest.version, release.version)).toBeLessThanOrEqual(0);
    const server = manifest.mcpServers["agent-governance-suite"];
    expect(server.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs"]);
    expect(server.env.AGENT_GOVERNANCE_DB_PATH).toBe("${CLAUDE_PLUGIN_DATA}/workflows.sqlite3");
    expect(server.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH).toBe("${CLAUDE_PLUGIN_DATA}/continuity.sqlite3");
    // The session board is shared with Codex in the user state directory, so the manifest does not pin it.
    expect(server.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH).toBeUndefined();
    expect(server.env.AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE).toBe("anthropic");
    expect(server.env.AGENT_GOVERNANCE_HOST_ATTESTATION).toBe("claude-code");
  });

  it("publishes a separate marketplace that points only at the generated tree", async () => {
    const claudeMarketplace = await readJson(root, ".claude-plugin", "marketplace.json");
    const codexMarketplace = await readJson(root, ".agents", "plugins", "marketplace.json");
    expect(claudeMarketplace.name).not.toBe(codexMarketplace.name);
    expect(claudeMarketplace.plugins).toEqual([
      expect.objectContaining({ name: "agent-governance-suite", source: `./${OUTPUT_DIRECTORY}` }),
    ]);
    const codexManifest = await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8");
    expect(codexManifest).not.toContain(OUTPUT_DIRECTORY);
    const codexMcp = await readFile(path.join(root, ".mcp.json"), "utf8");
    expect(codexMcp).not.toContain("AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE");
    expect(codexMcp).not.toContain("AGENT_GOVERNANCE_HOST_ATTESTATION");
  });

  it("puts the Claude selection decision at the top of the generated orchestrator skill", async () => {
    const generated = await readFile(path.join(pluginRoot, "skills", "orchestrator", "SKILL.md"), "utf8");
    const shared = await readFile(path.join(root, "skills", "orchestrator", "SKILL.md"), "utf8");
    expect(shared).not.toContain("## Claude Code에서의 선택 결정");
    expect(generated.indexOf("## Claude Code에서의 선택 decision".replace("decision", "결정"))).toBeLessThan(generated.indexOf("## 시작 전 확인"));
    for (const skill of ["task-contract", "change-scope-guardian", "acceptance-evidence-validator", "independent-audit-gate", "mutation-risk-preflight"]) {
      expect(generated).toContain(`\`${skill}\`:`);
    }
    expect(generated).toContain("agent-governance-suite:independent-auditor");
  });

  it("omits Codex-only skills from files, registry, and source lock", async () => {
    const skillDirectories = await readdir(path.join(pluginRoot, "skills"));
    const registry = await readJson(pluginRoot, "skills", "registry.json");
    const sourceLock = await readJson(pluginRoot, "skills", "source-lock.json");
    for (const skill of EXCLUDED_SKILLS) {
      expect(skillDirectories).not.toContain(skill);
      expect(registry.skills.map((entry) => entry.skillId)).not.toContain(skill);
      expect(sourceLock.sources.map((entry) => entry.skillId)).not.toContain(skill);
    }
  });

  it("registers exec-form continuity hooks plus the Claude-only skill trigger, host attestation and session board", async () => {
    const claudeHooks = await readJson(pluginRoot, "hooks", "hooks.json");
    // Parity with the Codex hook events is reported as drift, so a new Codex event never fails this test.
    expect(Object.keys(claudeHooks.hooks).sort()).toEqual(["PostCompact", "PostModelSwitch", "PreCompact", "PreToolUse", "SessionStart", "UserPromptSubmit"]);
    const allowedScripts = [
      "${CLAUDE_PLUGIN_ROOT}/hooks/continuity-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/skill-trigger-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/host-attestation-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/session-board-hook.mjs",
    ];
    for (const groups of Object.values(claudeHooks.hooks)) {
      for (const hook of groups.flatMap((group) => group.hooks)) {
        expect(hook).toMatchObject({ type: "command", command: "node" });
        expect(allowedScripts).toContain(hook.args[0]);
      }
    }
    // UserPromptSubmit runs the trigger hook and the session board, which records only the request time.
    expect(claudeHooks.hooks.UserPromptSubmit.flatMap((group) => group.hooks).map((hook) => hook.args[0])).toEqual([allowedScripts[1], allowedScripts[3]]);
    // The session board gates edits, shells and delegation, and binds only its own two MCP tools.
    const boardMatchers = claudeHooks.hooks.PreToolUse
      .filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[3]))
      .map((group) => new RegExp(group.matcher, "u"));
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", `${toolPrefix}update_session_status`, `${toolPrefix}list_session_status`]) {
      expect(boardMatchers.some((matcher) => matcher.test(tool))).toBe(true);
    }
    for (const tool of ["Read", "Grep", "Glob", `${toolPrefix}plan_workflow`, `${toolPrefix}record_stage_result`, ...continuityTools.map((name) => `${toolPrefix}${name}`)]) {
      expect(boardMatchers.some((matcher) => matcher.test(tool))).toBe(false);
    }
    const bashGroup = claudeHooks.hooks.PreToolUse.find((group) => group.matcher === "^Bash$");
    expect(bashGroup.hooks.map((hook) => hook.args[0])).toEqual([allowedScripts[1]]);
    const matcher = new RegExp(claudeHooks.hooks.PreToolUse[0].matcher, "u");
    for (const tool of continuityTools) {
      expect(matcher.test(`${toolPrefix}${tool}`)).toBe(true);
      expect(matcher.test(`mcp__agent-governance-suite__${tool}`)).toBe(false);
    }
    expect(matcher.test(`${toolPrefix}plan_workflow`)).toBe(false);
    // Host attestation is the only handler for exactly the two strict tools, so no other hook rewrites their input.
    const attestationGroups = claudeHooks.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[2]));
    expect(attestationGroups).toHaveLength(1);
    expect(attestationGroups[0].hooks.map((hook) => hook.args[0])).toEqual([allowedScripts[2]]);
    const attestationMatcher = new RegExp(attestationGroups[0].matcher, "u");
    for (const tool of ["plan_workflow", "record_stage_result"]) {
      expect(attestationMatcher.test(`${toolPrefix}${tool}`)).toBe(true);
      expect(claudeHooks.hooks.PreToolUse.filter((group) => new RegExp(group.matcher, "u").test(`${toolPrefix}${tool}`))).toHaveLength(1);
    }
    for (const tool of [...continuityTools, "claim_workflow_attempt", "start_guarded_workflow", "finalize_workflow"]) {
      expect(attestationMatcher.test(`${toolPrefix}${tool}`)).toBe(false);
    }
    // Interactive sessions write the issuing message late, so the session model is recorded from these events.
    for (const event of ["SessionStart", "PostModelSwitch"]) {
      const groups = claudeHooks.hooks[event].filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[2]));
      expect(groups).toHaveLength(1);
      expect(groups[0].matcher).toBeUndefined();
    }
  });

  it("exits quietly without touching shared state when plugin data is unavailable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "claude-plugin-hook-"));
    temporaryDirectories.push(home);
    const environment = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, "state"), LOCALAPPDATA: path.join(home, "local") };
    delete environment.CLAUDE_PLUGIN_DATA;
    delete environment.AGENT_GOVERNANCE_DB_PATH;
    delete environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH;
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "continuity-hook.mjs")], {
      encoding: "utf8",
      env: environment,
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "test-session" }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readdir(home)).toEqual([]);
  });

  it("emits no attestation and creates no state without plugin data", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "claude-plugin-attest-"));
    temporaryDirectories.push(home);
    const environment = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, "state"), LOCALAPPDATA: path.join(home, "local") };
    delete environment.CLAUDE_PLUGIN_DATA;
    delete environment.AGENT_GOVERNANCE_DB_PATH;
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "host-attestation-hook.mjs")], {
      encoding: "utf8",
      env: environment,
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "test-session", tool_name: `${toolPrefix}plan_workflow`, tool_use_id: "toolu_x", transcript_path: path.join(home, "t.jsonl"), tool_input: { taskId: "t" } }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readdir(home)).toEqual([]);
  });

  it("removes a caller-supplied token when it cannot attest", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "claude-plugin-attest-strip-"));
    temporaryDirectories.push(home);
    const input = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "test-session", tool_name: `${toolPrefix}plan_workflow`, tool_use_id: "toolu_x", transcript_path: path.join(home, "missing.jsonl"), tool_input: { taskId: "t", _hostAttestation: "aghs1.caller.forged" } });
    const withoutData = { ...process.env };
    delete withoutData.CLAUDE_PLUGIN_DATA;
    for (const env of [withoutData, { ...process.env, CLAUDE_PLUGIN_DATA: path.join(home, "data") }]) {
      const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "host-attestation-hook.mjs")], { encoding: "utf8", env, input });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { taskId: "t" } } });
    }
  }, 30_000);

  it("signs host attestation with a key in the plugin data directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "claude-plugin-attest-data-"));
    temporaryDirectories.push(data);
    const transcript = path.join(data, "session.jsonl");
    await writeFile(transcript, `${JSON.stringify({ type: "assistant", sessionId: "test-session", isSidechain: false, effort: "high", message: { model: "claude-opus-5", content: [{ type: "tool_use", id: "toolu_x", name: "plan_workflow", input: {} }] } })}\n`, "utf8");
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "host-attestation-hook.mjs")], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
      input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "test-session", tool_name: `${toolPrefix}plan_workflow`, tool_use_id: "toolu_x", transcript_path: transcript, tool_input: { taskId: "t" }, effort: { level: "high" } }),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.updatedInput).toMatchObject({ taskId: "t", _hostAttestation: expect.stringMatching(/^aghs1\./u) });
    expect(await readdir(data)).toContain("workflows.sqlite3");
  });

  it("stores continuity state under the plugin data directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "claude-plugin-data-"));
    temporaryDirectories.push(data);
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "continuity-hook.mjs")], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "test-session" }),
    });
    expect(result.status).toBe(0);
    expect(await readdir(data)).toContain("continuity.sqlite3");
  });
});

describe("Claude overlay safeguards", () => {
  it("reports Codex-only wording in model-visible files except dual-host documents", () => {
    const files = new Map([
      ["skills/example/SKILL.md", Buffer.from("Use `fork_turns:none` for reviewers.\n")],
      ["skills/example/references/guide.md", Buffer.from("Call $example-skill directly.\n")],
      ["skills/example/README.md", Buffer.from("Install with Codex.\n")],
      [DUAL_HOST_FILES[0], Buffer.from("Coordinate subagents in Codex and Claude Code.\n")],
    ]);
    expect(findCodexOnlyWording(files)).toEqual([
      `Codex-only wording in ${OUTPUT_DIRECTORY}/skills/example/SKILL.md:1`,
      `Codex-only wording in ${OUTPUT_DIRECTORY}/skills/example/references/guide.md:1`,
    ]);
  });

  it("applies each replacement exactly once and rejects missing or ambiguous text", () => {
    const files = new Map([["skills/example/SKILL.md", Buffer.from("alpha beta alpha")]]);
    applyReplacements(files, [{ file: "skills/example/SKILL.md", find: "beta", replace: "gamma" }]);
    expect(files.get("skills/example/SKILL.md").toString("utf8")).toBe("alpha gamma alpha");
    expect(() => applyReplacements(files, [{ file: "skills/example/SKILL.md", find: "beta", replace: "x" }])).toThrow(/not found/u);
    expect(() => applyReplacements(files, [{ file: "skills/example/SKILL.md", find: "alpha", replace: "x" }])).toThrow(/ambiguous/u);
    expect(() => applyReplacements(files, [{ file: "skills/missing/SKILL.md", find: "a", replace: "b" }])).toThrow(/not generated/u);
  });

  it("replaces the whole frontmatter description regardless of the shared wording", () => {
    const single = "---\nname: example\ndescription: Codex wording that may change.\n---\n# Body\ndescription: body text\n";
    expect(replaceFrontmatterDescription(single, "Claude trigger wording.")).toBe(
      "---\nname: example\ndescription: Claude trigger wording.\n---\n# Body\ndescription: body text\n",
    );
    const folded = "---\r\nname: example\r\ndescription: >\r\n  folded\r\n  lines\r\nlicense: MIT\r\n---\r\n";
    expect(replaceFrontmatterDescription(folded, "Claude.")).toBe("---\r\nname: example\r\ndescription: Claude.\r\nlicense: MIT\r\n---\r\n");
    expect(() => replaceFrontmatterDescription("# no frontmatter\n", "x")).toThrow(/no frontmatter/u);
    expect(() => replaceFrontmatterDescription("---\nname: example\n---\n", "x")).toThrow(/no description/u);
  });

  it("applies a skill adaptation with skill-relative paths and names the adaptation file on failure", () => {
    const files = new Map([
      ["skills/example/SKILL.md", Buffer.from("---\nname: example\ndescription: Codex.\n---\nUse `fork_turns:none`.\n")],
      ["skills/example/references/guide.md", Buffer.from("See .codex-plugin/plugin.json\n")],
    ]);
    applySkillAdaptation(files, "example", {
      description: "Claude.",
      replacements: [
        { file: "SKILL.md", find: "`fork_turns:none`", replace: "a new subagent" },
        { file: "references/guide.md", find: ".codex-plugin/plugin.json", replace: ".claude-plugin/plugin.json" },
      ],
    }, "claude-overlay/adaptations/example.json");
    expect(files.get("skills/example/SKILL.md").toString("utf8")).toBe("---\nname: example\ndescription: Claude.\n---\nUse a new subagent.\n");
    expect(files.get("skills/example/references/guide.md").toString("utf8")).toBe("See .claude-plugin/plugin.json\n");
    expect(() => applySkillAdaptation(files, "example", { replacements: [{ file: "SKILL.md", find: "gone", replace: "x" }] }, "claude-overlay/adaptations/example.json"))
      .toThrow(/^claude-overlay\/adaptations\/example\.json: replacement text not found/u);
    expect(() => applySkillAdaptation(files, "missing", { description: "x" })).toThrow(/skill is not generated/u);
    expect(() => applySkillAdaptation(files, "example", { summary: "x" })).toThrow(/unknown keys/u);
    expect(() => applySkillAdaptation(files, "example", { description: "two\nlines" })).toThrow(/single line/u);
    expect(() => applySkillAdaptation(files, "example", { replacements: [{ file: "../x.md", find: "a", replace: "b" }] })).toThrow(/invalid replacement/u);
  });

  it("maps Codex invocations of shipped skills to the Claude Code form only", () => {
    const files = new Map([
      ["skills/example/SKILL.md", Buffer.from("Call `$task-contract`, then $task-contract-v2, $skill-name and $codex-token-usage-analyzer.\n")],
      ["skills/example/scripts/run.mjs", Buffer.from("const skill = '$task-contract';\n")],
      [DUAL_HOST_FILES[0], Buffer.from("Codex: $task-contract\n")],
    ]);
    mapSkillInvocations(files, ["task-contract"]);
    expect(files.get("skills/example/SKILL.md").toString("utf8")).toBe(
      "Call `/agent-governance-suite:task-contract`, then $task-contract-v2, $skill-name and $codex-token-usage-analyzer.\n",
    );
    expect(files.get("skills/example/scripts/run.mjs").toString("utf8")).toBe("const skill = '$task-contract';\n");
    expect(files.get(DUAL_HOST_FILES[0]).toString("utf8")).toBe("Codex: $task-contract\n");
  });

  it("reports drift instead of throwing when the Claude plugin cannot be rendered", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claude-plugin-drift-"));
    temporaryDirectories.push(directory);
    const problems = await reportClaudePluginDrift(directory);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^render failed: /u);
  });

  it("still reports missing hook events when the Claude plugin cannot be rendered", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "claude-plugin-drift-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "hooks"), { recursive: true });
    await mkdir(path.join(directory, OUTPUT_DIRECTORY, "hooks"), { recursive: true });
    await writeFile(path.join(directory, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [], Stop: [] } }));
    await writeFile(path.join(directory, OUTPUT_DIRECTORY, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
    const problems = await reportClaudePluginDrift(directory);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^render failed: /u);
    expect(problems[1]).toMatch(/^Codex hook event Stop is not registered/u);
  });
});
