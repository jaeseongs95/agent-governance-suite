import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  // The package default locale is ko, so the English sentences asserted below pin the locale explicitly.
  beforeEach(() => { vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en"); });
  afterEach(() => { vi.unstubAllEnvs(); });

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

  it("recommends the high-risk preset first without refusing a supported user choice (AGS3-D-0058)", () => {
    expect(resolveModelSelection({ ...options(), role: "discovery", highRisk: true }).selection)
      .toEqual({ model: "gpt-5.6-terra", effort: "high" });
    for (const inherited of [undefined, { model: "gpt-5.6-luna", effort: "high" }, { model: "gpt-5.6-terra", effort: "medium" }]) {
      expect(resolveModelSelection({ ...options(), highRisk: true, user: { effort: "medium" }, inherited }))
        .toMatchObject({ delivery: "explicit", selection: { model: "gpt-5.6-terra", effort: "medium" } });
    }
    const safe = resolveModelSelection({ ...options(), highRisk: true, user: { model: "missing" }, inherited: { model: "gpt-5.6-sol", effort: "high" } });
    expect(safe.delivery).toBe("inherited");
    expect(safe.fallbackReason).toBeTruthy();
  });

  it("requires an explicit highRisk flag for an independent audit yet keeps its supported user choice (AGS3-D-0058)", () => {
    const audit = { ...options(), role: "independent-audit", user: { model: "gpt-5.6-luna", effort: "high" } };
    expect(() => resolveModelSelection(audit)).toThrow(/independent-audit requires highRisk/);
    expect(resolveModelSelection({ ...audit, highRisk: true }).selection).toEqual({ model: "gpt-5.6-luna", effort: "high" });
    expect(resolveModelSelection({ ...audit, highRisk: true, inherited: { model: "gpt-5.6-sol", effort: "high" } }).delivery).toBe("explicit");
  });

  it("does not infer support or model class and preserves the Luna minimum", () => {
    expect(resolveModelSelection({ ...options(), supported: [] }).delivery).toBe("blocked");
    const unknownClass = options();
    unknownClass.supported[1].modelClass = null;
    expect(resolveModelSelection({ ...unknownClass, highRisk: true }).selection).toEqual({ model: "gpt-5.6-terra", effort: "high" });
    expect(resolveModelSelection({ ...options(), role: "discovery", user: { effort: "medium" } }).delivery).toBe("blocked");
  });

  it("supports another provider without adding product names to core logic", () => {
    expect(resolveModelSelection({ provider: "fixture-host", role: "discovery", highRisk: false,
      supported: [{ model: "fixture", modelClass: null, efforts: ["low"] }], user: { model: "fixture", effort: "low" },
    }).selection).toEqual({ model: "fixture", effort: "low" });
    expect(resolveModelSelection({ provider: "anthropic-claude-code", role: "discovery", profile: "economy", highRisk: false,
      supported: [{ model: "haiku", modelClass: "lightweight", efforts: ["low"] }],
    }).selection).toEqual({ model: "haiku", effort: "low" });
    expect(resolveModelSelection({ provider: "google-gemini", role: "discovery", profile: "economy", highRisk: false,
      supported: [{ model: "flash-lite", modelClass: "lightweight", efforts: ["low"] }],
    }).selection).toEqual({ model: "flash-lite", effort: "low" });
    expect(resolveModelSelection({ provider: "google-gemini", role: "general-implementation", profile: "balanced", highRisk: false,
      supported: [{ model: "flash", modelClass: "general", efforts: ["high"] }],
    }).selection).toEqual({ model: "flash", effort: "high" });
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

  it("records unobservable inheritance at any risk level (AGS3-D-0058)", () => {
    const inherited = { ...record(), contextMode: "full-history", contextReason: "Prior context needed",
      options: { ...options(), inheritOnly: true, inheritanceSupported: true }, spawnArguments: { fork_turns: "all" },
    };
    expect(resolveModelSelection(inherited.options).delivery).toBe("inherited");
    expect(recordModelApplication(inherited).actual).toEqual({ status: "unverified", model: null, effort: null });
    expect(resolveModelSelection({ ...inherited.options, highRisk: true }).delivery).toBe("inherited");
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

  describe("independent audit context isolation", () => {
    const audit = () => ({
      ...record(), assignmentId: "audit-1", selectionReason: "Fresh high-risk audit",
      options: { ...options(), role: "independent-audit", highRisk: true },
      spawnArguments: { model: "gpt-6-astra", reasoning_effort: "high", fork_turns: "none" },
    });
    const inheritedAudit = () => ({
      ...audit(), contextMode: "full-history", contextReason: "Auditor needs prior discussion",
      options: { ...audit().options, inheritOnly: true, inherited: { model: "gpt-5.6-sol", effort: "high" } },
    });

    it("accepts an independent audit started with no parent turns", () => {
      const fresh = recordModelApplication(audit());
      expect(fresh.contextMode).toBe("limited");
      expect(fresh.spawnArguments.fork_turns).toBe("none");
    });

    it("rejects an independent audit that inherits a positive parent turn count", () => {
      expect(() => recordModelApplication({ ...audit(), spawnArguments: { ...audit().spawnArguments, fork_turns: "2" } }))
        .toThrow(/independent-audit-inherited-context/);
    });

    it("rejects an independent audit with full history even when a context reason is given", () => {
      expect(() => recordModelApplication({ ...inheritedAudit(), spawnArguments: { fork_turns: "all" } }))
        .toThrow(/independent-audit-inherited-context/);
      expect(() => recordModelApplication({ ...inheritedAudit(), spawnArguments: {} }))
        .toThrow(/independent-audit-inherited-context/);
      expect(() => recordModelApplication({
        assignmentId: "audit-2", selectionReason: "Fresh high-risk audit", contextMode: "full-history", contextReason: "Prior context",
        options: { provider: "anthropic-claude-code", profile: "economy", role: "independent-audit", highRisk: true,
          supported: [{ model: "opus", modelClass: "deep", efforts: ["high"] }] },
        spawnArguments: { model: "opus", effort: "high" }, observation: null,
      })).toThrow(/independent-audit-inherited-context/);
    });

    it("keeps positive parent turn counts available to non-audit roles", () => {
      for (const role of ["discovery", "general-implementation", "complex-reasoning"]) {
        const plan = resolveModelSelection({ ...options(), role });
        const result = recordModelApplication({ ...record(), options: { ...options(), role },
          spawnArguments: { model: plan.selection.model, reasoning_effort: plan.selection.effort, fork_turns: "3" } });
        expect(result.contextMode).toBe("limited");
      }
    });
  });

  it.each([["en"], ["ko"], [undefined]])("renders thrown errors and fallback reasons in the model locale, whatever the host locale (%s)", (locale) => {
    if (locale === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else vi.stubEnv("AGENT_GOVERNANCE_LOCALE", locale);
    const audit = { ...options(), role: "independent-audit", user: { model: "gpt-5.6-luna", effort: "high" } };
    expect(() => resolveModelSelection(audit)).toThrow(/independent-audit requires highRisk: true/);
    const inherited = resolveModelSelection({ ...options(), highRisk: true, user: { model: "missing" }, inherited: { model: "gpt-5.6-sol", effort: "high" } });
    expect(inherited.fallbackReason).toBe("Requested combination unavailable");
  });

  it("prints the model-locale usage sentence whatever the host locale and the bare message keys when the skill is copied alone", () => {
    const clean = mkdtempSync(path.join(tmpdir(), "routing-i18n-"));
    try {
      cpSync(new URL("../../skills/coordinate-subagents", import.meta.url), path.join(clean, "skill"), { recursive: true });
      const standaloneCli = path.join(clean, "skill/scripts/model-routing.mjs");
      const run = (script, locale) => {
        const env = { ...process.env };
        if (locale === undefined) delete env.AGENT_GOVERNANCE_LOCALE; else env.AGENT_GOVERNANCE_LOCALE = locale;
        return spawnSync(process.execPath, [script], { cwd: clean, encoding: "utf8", windowsHide: true, env });
      };
      const installed = fileURLToPath(new URL("../../skills/coordinate-subagents/scripts/model-routing.mjs", import.meta.url));
      for (const locale of ["en", "ko", undefined]) {
        expect(run(installed, locale).stderr.trim()).toBe("Usage: node model-routing.mjs resolve|record input.json [--presets presets.json]");
      }
      // No runtime/i18n.mjs beside a lone skill folder: the key is all there is to print.
      expect(run(standaloneCli, "en").stderr.trim()).toBe("skillTools.modelRouting.usage");
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  it("runs the public resolve and record CLI without node_modules", () => {
    const clean = mkdtempSync(path.join(tmpdir(), "routing-runtime-"));
    try {
      // The installed layout: the skill beside the shared runtime catalog it reads.
      cpSync(new URL("../../skills/coordinate-subagents", import.meta.url), path.join(clean, "skills/coordinate-subagents"), { recursive: true });
      cpSync(new URL("../../runtime/model-routing-presets.json", import.meta.url), path.join(clean, "runtime/model-routing-presets.json"));
      const input = path.join(clean, "input.json");
      const cli = path.join(clean, "skills/coordinate-subagents/scripts/model-routing.mjs");
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
