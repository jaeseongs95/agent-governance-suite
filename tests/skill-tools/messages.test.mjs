import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hostText, msg, render } from "../../runtime/i18n.mjs";

// The skillTools domain: sentences printed by the scripts of six skills (cs-engineering, task-contract,
// instruction-scope-resolver, iteration-frame-auditor, coordinate-subagents, session-board).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skills = ["cs-engineering", "task-contract", "instruction-scope-resolver", "iteration-frame-auditor", "coordinate-subagents", "session-board"];
const catalog = (locale) => JSON.parse(readFileSync(path.join(root, "locales", locale, "skillTools.json"), "utf8"));

function keysUsedByScripts() {
  const used = new Set();
  for (const skill of skills) {
    const directory = path.join(root, "skills", skill, "scripts");
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".mjs"))) {
      for (const match of readFileSync(path.join(directory, name), "utf8").matchAll(/skillTools\.[A-Za-z]+\.[A-Za-z0-9]+/gu)) used.add(match[0]);
    }
  }
  return used;
}

describe("skillTools catalog", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("holds exactly the keys the skill scripts use, in both locales", () => {
    const en = Object.keys(catalog("en")).sort();
    expect(Object.keys(catalog("ko")).sort()).toEqual(en);
    expect([...keysUsedByScripts()].sort()).toEqual(en);
  });

  it("renders every script sentence in the model locale, whatever the host locale, and the ko translation with its parameters filled in", () => {
    for (const key of Object.keys(catalog("en"))) {
      const names = new Set([...catalog("en")[key].matchAll(/\{\s*([A-Za-z_]\w*)\s*[,}]/gu)].map((match) => match[1]));
      const params = Object.fromEntries([...names].map((name) => [name, "PARAM"]));
      vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en");
      const english = hostText(key, params);
      for (const locale of ["ko", undefined]) {
        vi.stubEnv("AGENT_GOVERNANCE_LOCALE", locale);
        expect(hostText(key, params), `${key} (${locale})`).toBe(english);
      }
      expect(english, key).toBe(render(msg(key, params), "en"));
      expect(english, key).not.toMatch(/[가-힣]/u);
      // The ko catalog stays as translation material: it renders on request, apart from script output.
      const korean = render(msg(key, params), "ko");
      expect(english, key).not.toBe(korean);
      for (const text of [english, korean]) {
        expect(text.length, key).toBeGreaterThan(0);
        expect(text, key).not.toMatch(/[{}]/u);
        expect(text, key).not.toBe(key);
      }
    }
  });

  it("selects the label phrases of the label-style sentences in the model locale, whatever the host locale", () => {
    for (const locale of ["en", "ko", undefined]) {
      vi.stubEnv("AGENT_GOVERNANCE_LOCALE", locale);
      expect(hostText("skillTools.csEngineering.duplicate", { label: "candidateFile", value: "a.py" })).toBe("Duplicate candidate file: a.py.");
      expect(hostText("skillTools.csEngineering.digestMismatch", { label: "boundTask" })).toBe("Bound task mismatch.");
      expect(hostText("skillTools.iterationFrame.unknownEvidence", { subject: "attempt", id: "A-1", ref: "E-9" })).toBe("attempt A-1 references evidence outside evidenceInventory: E-9.");
    }
    // The ko translation keeps its own label phrases.
    expect(render(msg("skillTools.csEngineering.duplicate", { label: "candidateFile", value: "a.py" }), "ko")).toBe("중복된 후보 파일: a.py.");
    expect(render(msg("skillTools.csEngineering.digestMismatch", { label: "boundTask" }), "ko")).toBe("일치하지 않는다: 결속된 작업.");
    expect(render(msg("skillTools.iterationFrame.unknownEvidence", { subject: "attempt", id: "A-1", ref: "E-9" }), "ko")).toBe("attempt A-1: evidenceInventory 밖의 근거를 참조한다: E-9.");
  });
});
