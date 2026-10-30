import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { matchesGovernanceSourceSuccessor, matchesSkillPolicyWordingSuccessorBytes, readHistoricalSource } from "../../scripts/check-skill-context-optimization.mjs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyReplacements,
  applySkillAdaptation,
  checkClaudePlugin,
  DUAL_HOST_FILES,
  EXCLUDED_SKILLS,
  findCodexOnlyWording,
  mapSkillInvocations,
  OUTPUT_DIRECTORY,
  renderClaudePlugin,
  replaceFrontmatterDescription,
  reportClaudePluginDrift,
} from "../../scripts/build-claude-plugin.mjs";
import { SEMVER } from "../../scripts/release-metadata.mjs";

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
    expect(manifest.version).toMatch(SEMVER);
    // A fresh mirror carries the release version itself, which may be a prerelease; a lagging one an earlier release.
    expect(manifest.version === release.version || compareVersions(manifest.version, release.version) < 0).toBe(true);
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
    const release = await readJson(root, "release", "version.json");
    const claudeMarketplace = await readJson(root, ".claude-plugin", "marketplace.json");
    const codexMarketplace = await readJson(root, ".agents", "plugins", "marketplace.json");
    expect(claudeMarketplace.name).not.toBe(codexMarketplace.name);
    expect(claudeMarketplace.version).toBe(release.version);
    expect(claudeMarketplace.plugins).toEqual([
      expect.objectContaining({
        name: "agent-governance-suite",
        source: `./${OUTPUT_DIRECTORY}`,
        version: release.version,
        ref: `v${release.version}`,
      }),
    ]);
    expect(claudeMarketplace.plugins[0].ref).toBe(codexMarketplace.plugins[0].source.ref);
    const codexManifest = await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8");
    expect(codexManifest).not.toContain(OUTPUT_DIRECTORY);
    const codexMcp = await readFile(path.join(root, ".mcp.json"), "utf8");
    expect(codexMcp).not.toContain("AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE");
    expect(JSON.parse(codexMcp).mcpServers["agent-governance-suite"].env.AGENT_GOVERNANCE_HOST_ATTESTATION).toBe("codex");
    const claudeOverlay = await readJson(root, "claude-overlay", ".claude-plugin", "plugin.json");
    expect(claudeOverlay.mcpServers["agent-governance-suite"].env.AGENT_GOVERNANCE_HOST_ATTESTATION).toBe("claude-code");
  });

  it("keeps the orchestrator selection policy in the shared source and adapts only Claude invocation and observation", async () => {
    const orchestrator = (base, ...segments) => readFile(path.join(base, "skills", "orchestrator", ...segments), "utf8");
    const adaptation = await readJson(root, "claude-overlay", "adaptations", "orchestrator.json");
    const shared = await orchestrator(root, "SKILL.md");
    const generated = await orchestrator(pluginRoot, "SKILL.md");
    // The shared source names no host invocation syntax or product.
    for (const document of ["SKILL.md", "references/entry-details.md", "references/mcp-execution.md"]) {
      const text = await orchestrator(root, document);
      for (const hostSpecific of [/Skill 도구/u, /\/agent-governance-suite:/u, /(?<![\w$])\$[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/u, /Claude/u, /Codex/u, /UserPromptSubmit/u, /transcript/u]) {
        expect(text, document).not.toMatch(hostSpecific);
      }
      // References carry the shared policy to Claude byte for byte.
      if (document !== "SKILL.md") expect(await orchestrator(pluginRoot, document), document).toBe(text);
    }
    // The shared description and selection policy stay unchanged; only native invocation/observation is inserted.
    expect(adaptation).not.toHaveProperty("description");
    expect(adaptation.replacements).toHaveLength(1);
    const [{ find, replace }] = adaptation.replacements;
    const section = replace.slice(0, replace.length - find.length);
    expect(replace.endsWith(find)).toBe(true);
    expect(generated).toBe(shared.replace(find, replace));
    // The Claude section adapts invocation and observation without restating common policy.
    for (const hostOnly of ["Skill 도구", "/agent-governance-suite:<skill-name>", "agent-governance-suite:independent-auditor", "SessionStart", "transcript"]) {
      expect(section).toContain(hostOnly);
    }
    for (const policy of ["실패 영향", "outputFile", "requiredArtifacts", "`direct`", "`orchestrated`", "BINDING_REQUIRED", "plan_workflow` 전에", "minimal-implementation", "ponytail"]) {
      expect(section, policy).not.toContain(policy);
    }
    // Native hooks may describe observations, but they cannot prescribe recovery after a common rejection.
    expect(section).toContain("SessionStart·PostModelSwitch");
    expect(section).toContain("references/mcp-execution.md");
    expect(section).not.toMatch(/BINDING_INVALID[^\n]*(?:다시 실행|다시 한다|재시도|전환)/u);
    expect(section).not.toMatch(/5분[^\n]*(?:같은 호출|재시도|다시)/u);
    const recovery = await orchestrator(root, "references", "mcp-execution.md");
    for (const guard of ["실행 하한 미달이 확인된", "만료가 확인된 경우", "결속, 신선도, 한 번 소비와 기존 수렴 가드", "코드나 승인 대기 시간만으로 원인을 만료로 단정"]) {
      expect(recovery).toContain(guard);
    }
    // Each common selection sentence reaches Claude exactly once.
    for (const sentence of ["키워드, 파일 종류나 `complex` 표시만으로 스킬을 붙이지 않는다.", "필수 승인·검증·독립성 gate를 생략하는 권한으로 해석하지 않는다.", "이 문서와 참고 자료를 읽는 것은 전문 스킬 실행이 아니다."]) {
      expect(shared.split(sentence)).toHaveLength(2);
      expect(generated.split(sentence)).toHaveLength(2);
    }
  });

  it("keeps no copy of the common intake sentences in any tracked file outside the shared source", async () => {
    const shared = await readFile(path.join(root, "skills", "orchestrator", "SKILL.md"), "utf8");
    const intake = shared.split("<!-- skill-intake:start -->\n")[1].split("\n<!-- skill-intake:end -->")[0];
    const sentences = intake.split("\n").filter((line) => !line.startsWith("#")).flatMap((line) => line.replace(/^- /u, "").split(/(?<=다\.) /u)).filter((sentence) => sentence.length > 20);
    expect(sentences.length).toBeGreaterThan(10);
    // The classification projection embeds immutable canonical bytes mechanically;
    // it does not define another editable intake policy.
    const projectionPath = "claude-plugin/skills/classification-projection.json";
    const projection = JSON.parse(await readFile(path.join(root, projectionPath), "utf8"));
    const canonicalIntake = projection.canonicalSources.filter((source) => source.path === "skills/orchestrator/SKILL.md");
    expect(canonicalIntake).toHaveLength(1);
    expect(canonicalIntake[0].content).toBe(shared);
    const frozenAdditionPath = "scripts/fixtures/skill-classification-intake.2.9.1.md";
    const frozenAddition = await readFile(path.join(root, frozenAdditionPath), "utf8");
    // Frozen provenance stays intact; current governance intentionally replaces its imperative wording.
    expect(createHash("sha256").update(frozenAddition).digest("hex")).toBe("640b42d913010477835200f35303790cc2015fabc9740d97b4f0ddabbe6f7bd3");
    expect(matchesSkillPolicyWordingSuccessorBytes("skills/orchestrator/SKILL.md", Buffer.from(shared))).toBe(true);
    expect(matchesGovernanceSourceSuccessor("skills/orchestrator/SKILL.md", readHistoricalSource("skills/orchestrator/SKILL.md"))).toBe(true);
    const allowed = new Set(["skills/orchestrator/SKILL.md", "claude-plugin/skills/orchestrator/SKILL.md", "tests/tooling/claude-plugin.test.mjs", projectionPath, frozenAdditionPath]);
    const listed = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    expect(listed.status).toBe(0);
    const files = listed.stdout.split("\0").filter((file) => file && !allowed.has(file));
    expect(files.length).toBeGreaterThan(500);
    for (const file of files) {
      const text = await readFile(path.join(root, file), "utf8");
      for (const sentence of sentences) expect(text.includes(sentence), `${file}: ${sentence}`).toBe(false);
    }
  });

  it("keeps the session-start adapter thin while MCP supplies the common intake once", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-intake-port-"));
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())) throw new Error("Unexpected disposable fixture path");
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "hooks"));
    await mkdir(path.join(directory, "skills", "orchestrator"), { recursive: true });
    const launcher = await readFile(path.join(root, "claude-overlay", "hooks", "skill-trigger-hook.mjs"));
    const shared = await readFile(path.join(root, "skills", "orchestrator", "SKILL.md"), "utf8");
    // A changed source must change the emitted context, proving there is no adapter policy copy.
    const current = shared.replace("<!-- skill-intake:end -->", "fixture-source-revision\n<!-- skill-intake:end -->");
    const intake = current.split("<!-- skill-intake:start -->\n")[1].split("\n<!-- skill-intake:end -->")[0];
    const hook = path.join(directory, "hooks", "skill-trigger-hook.mjs");
    await writeFile(hook, launcher);
    await writeFile(path.join(directory, "skills", "orchestrator", "SKILL.md"), current);
    const invoke = (input) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: "utf8" });
    const start = invoke({ hook_event_name: "SessionStart", source: "startup" });
    expect(start.status).toBe(0);
    expect(start.stderr).toBe("");
    const context = JSON.parse(start.stdout).hookSpecificOutput;
    expect(context.hookEventName).toBe("SessionStart");
    expect(context.additionalContext).toBe("Claude Code 호출: MCP 서버 instructions의 공통 접수 기준을 따르고, 선택한 설치 스킬은 Skill 도구나 /agent-governance-suite:<skill-name> 명령으로 실제 호출한다.");
    expect(context.additionalContext).not.toContain(intake);
    expect(context.additionalContext).not.toContain("fixture-source-revision");
    for (const prompt of ["git rebase랑 merge 차이가 뭐예요? 간단히 설명해 주세요.", "안녕하세요!", "change.diff 파일에 있는 변경 사항을 리뷰해 주세요."]) {
      const result = invoke({ hook_event_name: "UserPromptSubmit", prompt });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }
    const bash = invoke({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git merge feature" } });
    expect(bash.status).toBe(0);
    expect(bash.stdout).toBe("");
    const invalid = spawnSync(process.execPath, [hook], { input: "not-json", encoding: "utf8" });
    expect(invalid.status).toBe(0);
    expect(invalid.stdout).toBe("");
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

  it("registers one fail-closed governance entry for every AGS tool and preserves the advisory adapters", async () => {
    const claudeHooks = await readJson(pluginRoot, "hooks", "hooks.json");
    // Parity with the Codex hook events is reported as drift, so a new Codex event never fails this test.
    expect(Object.keys(claudeHooks.hooks).sort()).toEqual(["PostCompact", "PostModelSwitch", "PostToolUse", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    const allowedScripts = [
      "${CLAUDE_PLUGIN_ROOT}/hooks/continuity-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/skill-trigger-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/host-attestation-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/session-board-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/session-message-hook.mjs",
      "${CLAUDE_PLUGIN_ROOT}/hooks/governance-hook.mjs",
    ];
    for (const [event, groups] of Object.entries(claudeHooks.hooks)) {
      for (const hook of groups.flatMap((group) => group.hooks)) {
        expect(hook).toMatchObject({ type: "command", command: "node" });
        expect(allowedScripts).toContain(hook.args[0]);
        if (hook.args[0] === allowedScripts[5]) expect(event).toBe("PreToolUse");
        else expect(hook.onFailure).toBeUndefined();
      }
    }
    // Messaging runs before the board; the intake has no per-prompt selector.
    expect(claudeHooks.hooks.UserPromptSubmit.flatMap((group) => group.hooks).map((hook) => hook.args[0])).toEqual([allowedScripts[4], allowedScripts[3]]);
    // 공식 비동기 시작이 훅과 relay 계보를 유지하며 본문 수신 훅은 계속 동기로 실행한다.
    const messageSessionStart = claudeHooks.hooks.SessionStart.filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[4]));
    expect(messageSessionStart).toHaveLength(1);
    expect(messageSessionStart[0].hooks).toEqual([expect.objectContaining({ command: "node", args: [allowedScripts[4], "--own-relay"], async: true })]);
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
      for (const hook of claudeHooks.hooks[event].flatMap(group => group.hooks).filter(hook => hook.args[0] === allowedScripts[4])) {
        expect(hook.args).toEqual([allowedScripts[4]]);
        expect(hook.async).toBeUndefined();
      }
    }

    const governanceGroups = claudeHooks.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[5]));
    expect(governanceGroups).toHaveLength(1);
    expect(governanceGroups[0].matcher).toBe("^mcp__plugin_agent-governance-suite_agent-governance-suite__.+$");
    expect(governanceGroups[0].hooks).toEqual([{
      type: "command", command: "node", args: [allowedScripts[5]], timeout: 10, onFailure: "block",
    }]);
    const matcher = new RegExp(governanceGroups[0].matcher, "u");
    // Cover each former domain plus public reads and a future tool without another tool list.
    const governanceNames = ["plan_workflow", "record_stage_result", "classify_skills", "record_skill_selection",
      "prepare_session_message", "send_session_message", "acknowledge_session_messages", "get_session_message_status", "validate_collaboration_decision",
      "update_session_status", "list_session_status", ...continuityTools, "get_trust_capabilities", "get_skill_inventory", "future_governance_tool"];
    for (const tool of governanceNames) {
      expect(matcher.test(`${toolPrefix}${tool}`), tool).toBe(true);
      const matchingGroups = claudeHooks.hooks.PreToolUse.filter((group) => new RegExp(group.matcher, "u").test(`${toolPrefix}${tool}`));
      expect(matchingGroups, tool).toHaveLength(1);
      expect(matchingGroups[0].hooks.map((hook) => hook.args[0]), tool).toEqual([allowedScripts[5]]);
      expect(matcher.test(`mcp__agent-governance-suite__${tool}`), tool).toBe(false);
    }
    for (const tool of [toolPrefix, "Bash", "Edit", "Agent", "mcp__unrelated__get_trust_capabilities"]) expect(matcher.test(tool), tool).toBe(false);
    // The only remaining direct domain hook is the advisory board for non-AGS tools.
    expect(claudeHooks.hooks.PreToolUse).toHaveLength(2);
    const boardGroups = claudeHooks.hooks.PreToolUse.filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[3]));
    expect(boardGroups).toHaveLength(1);
    expect(boardGroups[0].hooks).toEqual([{ type: "command", command: "node", args: [allowedScripts[3]], timeout: 5 }]);
    const boardMatcher = new RegExp(boardGroups[0].matcher, "u");
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task"]) expect(boardMatcher.test(tool), tool).toBe(true);
    for (const tool of ["Read", "Grep", "Glob", ...governanceNames.map((name) => `${toolPrefix}${name}`)]) expect(boardMatcher.test(tool), tool).toBe(false);
    const intakeGroups = claudeHooks.hooks.SessionStart.filter((group) => group.hooks.some((hook) => hook.args[0] === allowedScripts[1]));
    expect(intakeGroups).toHaveLength(1);
    for (const script of [allowedScripts[0], allowedScripts[1], allowedScripts[4]]) {
      const groups = claudeHooks.hooks.SessionStart.filter((group) => group.hooks.some((hook) => hook.args[0] === script));
      expect(groups).toHaveLength(1);
      expect(new RegExp(groups[0].matcher, "u").test("fork"), script).toBe(true);
      expect(new RegExp(groups[0].matcher, "u").test("unknown-start-source"), script).toBe(false);
    }
    // Interactive sessions still record the issuing model from these lifecycle events.
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
    expect(output.hookSpecificOutput.updatedInput).toMatchObject({ taskId: "t", _hostAttestation: expect.stringMatching(/^aghs2\./u) });
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
  // Shared-source changes may leave the committed plugin behind until release.
  // Exercise the release check in an isolated installation tree instead of
  // imposing source freshness on every shared-source development change.
  const evaluationSchema = "contracts/skill-classification-evaluation-configuration.v1.schema.json";
  const serverBundle = "mcp-server/dist/server.mjs";

  async function distributionFixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "claude-plugin-distribution-"));
    temporaryDirectories.push(directory);
    const write = async (file, content) => {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), content);
    };
    for (const file of [evaluationSchema, serverBundle]) await write(file, await readFile(path.join(root, file)));
    await write("release/version.json", JSON.stringify({ version: "2.9.1" }));
    await write("skills/registry.json", JSON.stringify({ skills: [] }));
    await write("hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [] } }));
    await write("claude-overlay/hooks/hooks.json", JSON.stringify({ hooks: { SessionStart: [] } }));
    await write("claude-overlay/.claude-plugin/plugin.json", JSON.stringify({ name: "agent-governance-suite" }));
    for (const args of [["init"], ["add", "."]]) {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
    const refresh = async () => {
      for (const [file, content] of await renderClaudePlugin(directory)) await write(`${OUTPUT_DIRECTORY}/${file}`, content);
    };
    await refresh();
    return { directory, refresh, write };
  }

  it("separates unreadable installed files from missing ones", async () => {
    const { directory } = await distributionFixture();
    const installed = `${OUTPUT_DIRECTORY}/${evaluationSchema}`;
    await rm(path.join(directory, installed));
    await mkdir(path.join(directory, installed));
    expect(await checkClaudePlugin(directory)).toEqual([`unreadable file ${installed} (readFile EISDIR); not compared`]);
    await rm(path.join(directory, OUTPUT_DIRECTORY), { recursive: true });
    await writeFile(path.join(directory, OUTPUT_DIRECTORY), "not a directory");
    const [problem] = await checkClaudePlugin(directory);
    expect(problem).toBe(`${OUTPUT_DIRECTORY}/ is unreadable (readdir ENOTDIR); fix access to it before comparing`);
  });

  it("injects EACCES and EIO at the real CLI boundary without misclassifying access failures as missing or JSON syntax errors", async () => {
    const { directory } = await distributionFixture();
    const installed = `${OUTPUT_DIRECTORY}/${evaluationSchema}`;
    const hooksFile = "hooks/hooks.json";
    const preload = path.join(directory, "cli-errno-preload.mjs");
    const traceFile = path.join(directory, "cli-errno-trace.json");
    const buildScript = path.join(root, "scripts", "build-claude-plugin.mjs");
    await writeFile(preload, `
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const targetPath = path.resolve(process.env.AGS_TEST_FAULT_TARGET ?? "");
const targetOp = process.env.AGS_TEST_FAULT_OP ?? "";
const targetCode = process.env.AGS_TEST_FAULT_CODE ?? "";
const tracePath = process.env.AGS_TEST_FAULT_TRACE ?? "";
const original = { readFile: fs.readFile, readdir: fs.readdir };
const calls = [];
const record = (entry) => {
  calls.push(entry);
  if (tracePath) writeFileSync(tracePath, JSON.stringify(calls));
};

fs.readdir = async function(dirPath, ...args) {
  const resolved = path.resolve(String(dirPath));
  if (targetOp === "readdir" && resolved === targetPath) {
    record({ op: "readdir", path: resolved, code: targetCode });
    throw Object.assign(new Error(\`synthetic readdir \${targetCode}\`), { code: targetCode });
  }
  return original.readdir.call(this, dirPath, ...args);
};

fs.readFile = async function(filePath, ...args) {
  const resolved = path.resolve(String(filePath));
  if (targetOp === "readFile" && resolved === targetPath) {
    record({ op: "readFile", path: resolved, code: targetCode });
    throw Object.assign(new Error(\`synthetic readFile \${targetCode}\`), { code: targetCode });
  }
  return original.readFile.call(this, filePath, ...args);
};

syncBuiltinESMExports();
`, "utf8");

    const runCli = async (flag, op, relTarget, code) => {
      await rm(traceFile, { force: true });
      const target = path.resolve(directory, ...relTarget.split("/"));
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, buildScript, flag],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            AGENT_GOVERNANCE_ROOT: directory,
            AGS_TEST_FAULT_OP: op,
            AGS_TEST_FAULT_TARGET: target,
            AGS_TEST_FAULT_CODE: code,
            AGS_TEST_FAULT_TRACE: traceFile,
          },
        },
      );
      const trace = JSON.parse(await readFile(traceFile, "utf8"));
      return { result, trace, target };
    };

    for (const code of ["EACCES", "EIO"]) {
      const checkFile = await runCli("--check", "readFile", installed, code);
      expect(checkFile.trace).toEqual([{ op: "readFile", path: checkFile.target, code }]);
      expect(checkFile.result.status).toBe(1);
      expect(checkFile.result.stdout).not.toContain("fresh");
      expect(checkFile.result.stderr).toContain(`- unreadable file ${installed} (readFile ${code}); not compared`);
      expect(checkFile.result.stderr).not.toContain(`missing file ${installed}`);
      expect(checkFile.result.stderr).not.toMatch(/SyntaxError|Unexpected token|JSON/u);

      const driftFile = await runCli("--drift", "readFile", installed, code);
      expect(driftFile.trace).toEqual([{ op: "readFile", path: driftFile.target, code }]);
      expect(driftFile.result.status).toBe(0);
      expect(driftFile.result.stdout).not.toContain(`${OUTPUT_DIRECTORY}: fresh`);
      expect(driftFile.result.stdout).toContain(`- unreadable file ${installed} (readFile ${code}); not compared`);

      const checkDir = await runCli("--check", "readdir", OUTPUT_DIRECTORY, code);
      expect(checkDir.trace).toEqual([{ op: "readdir", path: checkDir.target, code }]);
      expect(checkDir.result.status).toBe(1);
      expect(checkDir.result.stdout).not.toContain("fresh");
      expect(checkDir.result.stderr).toContain(`- ${OUTPUT_DIRECTORY}/ is unreadable (readdir ${code}); fix access to it before comparing`);
      expect(checkDir.result.stderr).not.toContain(`${OUTPUT_DIRECTORY}/ is missing`);

      const driftDir = await runCli("--drift", "readdir", OUTPUT_DIRECTORY, code);
      expect(driftDir.trace).toEqual([{ op: "readdir", path: driftDir.target, code }]);
      expect(driftDir.result.status).toBe(0);
      expect(driftDir.result.stdout).not.toContain(`${OUTPUT_DIRECTORY}: fresh`);
      expect(driftDir.result.stdout).toContain(`- ${OUTPUT_DIRECTORY}/ is unreadable (readdir ${code}); fix access to it before comparing`);

      const checkHook = await runCli("--check", "readFile", hooksFile, code);
      expect(checkHook.trace).toEqual([{ op: "readFile", path: checkHook.target, code }]);
      expect(checkHook.result.status).toBe(1);
      expect(checkHook.result.stdout).not.toContain("fresh");
      expect(checkHook.result.stderr).toContain(`${hooksFile} (readFile ${code})`);
      expect(checkHook.result.stderr).not.toContain(`synthetic readFile ${code}`);
      expect(checkHook.result.stderr).not.toContain(directory);
      expect(checkHook.result.stderr).not.toMatch(/SyntaxError|Unexpected token|JSON/u);
    }

    await writeFile(path.join(directory, hooksFile), "{ invalid json\n", "utf8");
    const syntaxCheck = spawnSync(process.execPath, [buildScript, "--check"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", AGENT_GOVERNANCE_ROOT: directory },
    });
    expect(syntaxCheck.status).toBe(1);
    expect(syntaxCheck.stdout).not.toContain("fresh");
    expect(syntaxCheck.stderr).toMatch(/Expected property name|Unexpected token|JSON/u);
    expect(syntaxCheck.stderr).toContain(`${hooksFile} (JSON.parse SyntaxError)`);
    expect(syntaxCheck.stderr).not.toContain("invalid json");
    expect(syntaxCheck.stderr).not.toContain(directory);
  });

  it("ships the evaluation configuration contract and server bytes without development dependencies", async () => {
    const { directory } = await distributionFixture();
    for (const file of [evaluationSchema, serverBundle]) {
      expect(await readFile(path.join(directory, OUTPUT_DIRECTORY, file))).toEqual(await readFile(path.join(root, file)));
    }
    expect(await readdir(directory)).not.toContain("node_modules");
    expect(await checkClaudePlugin(directory)).toEqual([]);
  });

  it("includes untracked non-ignored shared skill files when rendering and checking the Claude plugin", async () => {
    const { directory, refresh, write } = await distributionFixture();
    const untrackedSkillScript = "skills/coordinate-subagents/scripts/model-catalog-adapter.mjs";
    const scriptContent = "export const modelCatalogAdapter = true;\n";
    await write(untrackedSkillScript, scriptContent);
    expect(await checkClaudePlugin(directory)).toEqual([`missing file ${OUTPUT_DIRECTORY}/${untrackedSkillScript} (readFile ENOENT)`]);
    await refresh();
    expect(await readFile(path.join(directory, OUTPUT_DIRECTORY, untrackedSkillScript), "utf8")).toBe(scriptContent);
    expect(await checkClaudePlugin(directory)).toEqual([]);
  });

  it.each([
    ["missing evaluation configuration contract", evaluationSchema, "missing"],
    ["stale server bundle", serverBundle, "stale"],
  ])("detects and repairs a %s through normal rendering", async (_name, file, problem) => {
    const { directory, refresh, write } = await distributionFixture();
    const installed = `${OUTPUT_DIRECTORY}/${file}`;
    if (problem === "missing") await rm(path.join(directory, installed));
    else await write(installed, "// stale installed bundle\n");
    expect(await checkClaudePlugin(directory)).toEqual([`${problem} file ${installed}${problem === "missing" ? " (readFile ENOENT)" : ""}`]);
    await refresh();
    expect(await checkClaudePlugin(directory)).toEqual([]);
    expect(await readFile(path.join(directory, installed))).toEqual(await readFile(path.join(root, file)));
  });

  it("keeps change-scope-guardian and korean-prose-editor descriptions aligned with canonical SKILL.md without overbroad triggers", async () => {
    for (const [skillId, forbiddenTriggers] of [
      ["change-scope-guardian", ["여러 파일을 고치거나", "미커밋 변경이 있는 트리에서 작업을 시작할 때 기준 상태를 남기고", "git commit·merge 전에"]],
      ["korean-prose-editor", ["문서 초안을 쓰거나 다듬을 때"]],
    ]) {
      const adaptation = await readJson(root, "claude-overlay", "adaptations", `${skillId}.json`);
      expect(adaptation).not.toHaveProperty("description");
      const shared = await readFile(path.join(root, "skills", skillId, "SKILL.md"), "utf8");
      const generated = await readFile(path.join(pluginRoot, "skills", skillId, "SKILL.md"), "utf8");
      const extractDescription = (text) => text.match(/^---\r?\n[\s\S]*?^description:\s*(.+)$/mu)?.[1]?.trim();
      expect(extractDescription(generated)).toBe(extractDescription(shared));
      for (const phrase of forbiddenTriggers) {
        expect(generated).not.toContain(phrase);
      }
    }
  });

  it("does not render Codex-only OpenAI agent metadata", async () => {
    const files = await renderClaudePlugin(root);
    expect([...files.keys()].filter((file) => /^skills\/[^/]+\/agents\/openai\.yaml$/u.test(file))).toEqual([]);
    expect(files.has("contracts/source-lock.v3.schema.json")).toBe(true);
    expect(files.has("contracts/source-lock.v2.schema.json")).toBe(false);
  });

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
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^render failed: /u);
    expect(problems[1]).toMatch(/^hook event drift not checked: .*ENOENT/u);
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
