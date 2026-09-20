import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { recordModelApplication, resolveModelSelection } from "../../skills/coordinate-subagents/scripts/model-routing.mjs";

const options = () => ({
  provider: "openai-codex", role: "general-implementation", highRisk: false,
  supported: [
    { model: "gpt-5.6-luna", modelClass: "lightweight", efforts: ["medium", "high"] },
    { model: "gpt-5.6-terra", modelClass: "general", efforts: ["medium", "high"] },
    { model: "gpt-5.6-sol", modelClass: "deep", efforts: ["medium", "high"] },
    { model: "gpt-6-astra", modelClass: "frontier", efforts: ["high", "xhigh"] },
  ],
});
const record = () => ({
  assignmentId: "review-1", selectionReason: "Bounded code review", contextMode: "limited",
  options: options(), spawnArguments: { model: "gpt-5.6-terra", reasoning_effort: "medium", fork_turns: "none" }, observation: null,
});

describe("packaged model routing", () => {
  it.each([
    ["discovery", "gpt-5.6-luna", "high"],
    ["general-implementation", "gpt-5.6-terra", "medium"],
    ["complex-reasoning", "gpt-5.6-sol", "high"],
    ["independent-audit", "gpt-6-astra", "high"],
  ])("resolves balanced %s against current capabilities", (role, model, effort) => {
    expect(resolveModelSelection({ ...options(), role, highRisk: role === "independent-audit" }).selection).toEqual({ model, effort });
  });

  it("honors model-only and effort-only user choices", () => {
    expect(resolveModelSelection({ ...options(), user: { model: "gpt-5.6-sol" } }).selection)
      .toEqual({ model: "gpt-5.6-sol", effort: "medium" });
    expect(resolveModelSelection({ ...options(), user: { effort: "high" } }).selection)
      .toEqual({ model: "gpt-5.6-terra", effort: "high" });
  });

  it("enforces the risk floor for presets, overrides and inherited fallback", () => {
    expect(resolveModelSelection({ ...options(), role: "discovery", highRisk: true }).selection)
      .toEqual({ model: "gpt-5.6-terra", effort: "high" });
    for (const inherited of [undefined, { model: "gpt-5.6-luna", effort: "high" }, { model: "gpt-5.6-terra", effort: "medium" }]) {
      expect(resolveModelSelection({ ...options(), highRisk: true, user: { effort: "medium" }, inherited }).delivery).toBe("blocked");
    }
    const safe = resolveModelSelection({ ...options(), highRisk: true, user: { model: "missing" }, inherited: { model: "gpt-5.6-sol", effort: "high" } });
    expect(safe.delivery).toBe("inherited");
    expect(safe.fallbackReason).toBeTruthy();
  });

  it("does not allow an independent auditor to opt out of the mandatory risk floor", () => {
    const audit = { ...options(), role: "independent-audit", user: { model: "gpt-5.6-luna", effort: "high" } };
    expect(() => resolveModelSelection(audit)).toThrow(/independent-audit requires highRisk/);
    expect(resolveModelSelection({ ...audit, highRisk: true }).delivery).toBe("blocked");
    expect(resolveModelSelection({ ...audit, highRisk: true, inherited: { model: "gpt-5.6-sol", effort: "high" } }).delivery).toBe("inherited");
  });

  it("does not infer support or model class and preserves the Luna minimum", () => {
    expect(resolveModelSelection({ ...options(), supported: [] }).delivery).toBe("blocked");
    const unknownClass = options();
    unknownClass.supported[1].modelClass = null;
    expect(resolveModelSelection({ ...unknownClass, highRisk: true }).delivery).toBe("blocked");
    expect(resolveModelSelection({ ...options(), role: "discovery", user: { effort: "medium" } }).delivery).toBe("blocked");
  });

  it("supports another provider without adding product names to core logic", () => {
    expect(resolveModelSelection({ provider: "fixture-host", role: "discovery", highRisk: false,
      supported: [{ model: "fixture", modelClass: null, efforts: ["low"] }], user: { model: "fixture", effort: "low" },
    }).selection).toEqual({ model: "fixture", effort: "low" });
    expect(resolveModelSelection({ provider: "anthropic-claude-code", role: "discovery", profile: "economy", highRisk: false,
      supported: [{ model: "haiku", modelClass: "lightweight", efforts: ["low"] }],
    }).selection).toEqual({ model: "haiku", effort: "low" });
  });

  it("preserves partial overrides with an unknown provider", () => {
    const unknown = { provider: "fixture-host", role: "discovery", highRisk: false,
      supported: ["base", "chosen"].map((model) => ({ model, modelClass: null, efforts: ["low", "high"] })),
      inherited: { model: "base", effort: "low" },
    };
    expect(resolveModelSelection({ ...unknown, user: { model: "chosen" } }).selection).toEqual({ model: "chosen", effort: "low" });
    expect(resolveModelSelection({ ...unknown, user: { effort: "high" } }).selection).toEqual({ model: "base", effort: "high" });
    expect(resolveModelSelection({ ...unknown, inherited: undefined, user: { model: "chosen" } }).requested).toEqual({ model: "chosen", effort: null });
  });

  it("records unobservable low-risk inheritance without weakening the high-risk floor", () => {
    const inherited = { ...record(), contextMode: "full-history", contextReason: "Prior context needed",
      options: { ...options(), inheritOnly: true, inheritanceSupported: true }, spawnArguments: { fork_turns: "all" },
    };
    expect(resolveModelSelection(inherited.options).delivery).toBe("inherited");
    expect(recordModelApplication(inherited).actual).toEqual({ status: "unverified", model: null, effort: null });
    expect(resolveModelSelection({ ...inherited.options, highRisk: true }).delivery).toBe("blocked");
    expect(resolveModelSelection({ ...inherited.options, inheritanceSupported: false }).delivery).toBe("blocked");
  });

  it("binds recorded context and settings to actual host arguments including defaults", () => {
    expect(() => recordModelApplication({ ...record(), spawnArguments: { ...record().spawnArguments, fork_turns: "all" } })).toThrow(/contradicts/);
    expect(() => recordModelApplication({ ...record(), spawnArguments: { model: "gpt-5.6-terra", reasoning_effort: "medium" } })).toThrow(/contradicts/);
    expect(() => recordModelApplication({ ...record(), spawnArguments: { ...record().spawnArguments, fork_turns: "0" } })).toThrow(/Invalid host context/);
    const actual = recordModelApplication({ ...record(), spawnArguments: { ...record().spawnArguments, fork_turns: "2" } });
    expect(actual.contextMode).toBe("limited");
    expect(actual.spawnArguments.fork_turns).toBe("2");
    expect(actual.dispatched).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
  });

  it("rejects partial actual arguments and distinguishes accepted from applied", () => {
    expect(() => recordModelApplication({ ...record(), spawnArguments: { model: "gpt-5.6-terra", fork_turns: "none" } })).toThrow(/Both dispatched/);
    expect(recordModelApplication(record()).actual.status).toBe("unverified");
    const observation = { model: "gpt-5.6-terra", effort: "medium", source: "spawn-result", reference: "tool-result:1" };
    expect(recordModelApplication({ ...record(), observation }).actual.status).toBe("applied");
    expect(recordModelApplication({ ...record(), observation: { ...observation, effort: "high" } }).actual)
      .toEqual({ status: "unverified", model: "gpt-5.6-terra", effort: "high" });
    expect(() => recordModelApplication({ ...record(), observation: { ...observation, source: "worker-self-report" } })).toThrow(/caller-visible/);
  });

  it("rejects full-history overrides and distinguishes observed inheritance", () => {
    const full = { ...record(), contextMode: "full-history", contextReason: "Prior context is required", spawnArguments: { ...record().spawnArguments, fork_turns: "all" } };
    expect(() => recordModelApplication(full)).toThrow(/Full-history/);
    full.options.inheritOnly = true;
    full.options.inherited = { model: "gpt-5.6-sol", effort: "high" };
    full.spawnArguments = { fork_turns: "all" };
    expect(recordModelApplication(full).actual.status).toBe("unverified");
    expect(recordModelApplication({ ...full, observation: { ...full.options.inherited, source: "host-task-view", reference: "host:2" } }).actual.status).toBe("inherited");
  });

  it("runs the public resolve and record CLI without node_modules", () => {
    const clean = mkdtempSync(path.join(tmpdir(), "routing-runtime-"));
    try {
      cpSync(new URL("../../skills/coordinate-subagents", import.meta.url), path.join(clean, "skill"), { recursive: true });
      const input = path.join(clean, "input.json");
      const cli = path.join(clean, "skill/scripts/model-routing.mjs");
      const env = { ...process.env };
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      writeFileSync(input, JSON.stringify(options()), "utf8");
      const run = (operation) => JSON.parse(execFileSync(process.execPath, [cli, operation, input], { cwd: clean, env, encoding: "utf8", windowsHide: true }));
      expect(run("resolve").delivery).toBe("explicit");
      writeFileSync(input, JSON.stringify(record()), "utf8");
      expect(run("record").actual.status).toBe("unverified");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
