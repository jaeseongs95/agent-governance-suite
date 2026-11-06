import {cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {describe, expect, it} from "vitest";
import * as api from "./bootstrap.mjs";
import {checkProviderObservationRetention} from "./provider-observation-retention.mjs";
import {loadCurrentSourceBindings} from "../evaluation.js";
import {readyMock} from "./prepared-fixture.mjs";
import {bindProviderRetentionSources, PROVIDER_RETENTION_PURPOSE} from "./provider-retention-sources.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");

// Cases, preconditions and failure oracles are written in provider-retention-source-test-plan.md.
// Local product execution is prohibited; these cases run only on Actions/TEST.
async function sourceMismatches(current: {manifest: {bindings: {path: string; digest: string | null}[]}; resolveDigest(path: string, digest: string): string | null},
  sourceSkills: {path: string; digest: string}[]) {
  const expected = new Map<string, string | null>(sourceSkills.map(source =>
    [source.path, current.resolveDigest(source.path, source.digest)]));
  for (const source of current.manifest.bindings) expected.set(source.path, source.digest);
  const mismatches = [];
  for (const [file, digest] of expected) {
    const bytes = await readFile(path.join(repo, file)).catch(error => {if (error.code === "ENOENT") return null; throw error;});
    const actual = bytes === null ? null : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== digest) mismatches.push({file, expected: digest, actual});
  }
  return mismatches;
}

async function preserveAndRemove(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("ags-provider-retention-")) throw new Error("TEMP_SCOPE_MISMATCH");
  if (process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR) {
    const evidence = path.resolve(process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR);
    const relative = path.relative(target, evidence);
    if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) throw new Error("EVIDENCE_MUST_BE_OUTSIDE_TEMP");
    await mkdir(evidence, {recursive: true});
    await cp(target, path.join(evidence, path.basename(target)), {recursive: true, force: false, errorOnExist: true});
  }
  await rm(target, {recursive: true, force: true});
}

describe("prepared evaluation provider observation retention", () => {
  it("PRS-01 keeps the old source contract distinct from the seven approved purpose changes", async () => {
    const legacy = loadCurrentSourceBindings(repo);
    const corpus = JSON.parse(await readFile(path.join(repo, "tests/skill-classification/fixtures.json"), "utf8"));
    const mismatches = await sourceMismatches(legacy, corpus.sourceSkills);
    expect(mismatches.map(item => item.file).sort()).toEqual([
      "skills/codex-token-usage-analyzer/SKILL.md",
      "skills/codex-token-usage-analyzer/classification.json",
      "skills/coordinate-subagents/SKILL.md",
      "skills/coordinate-subagents/classification.json",
      "skills/coordinate-subagents/references/entry-details.md",
      "skills/model-effort-advisor/SKILL.md",
      "skills/model-effort-advisor/classification.json",
    ]);
  });
  it("binds the current public sources before evaluating provider response retention", async () => {
    const legacy = loadCurrentSourceBindings(repo);
    const corpus = JSON.parse(await readFile(path.join(repo, "tests/skill-classification/fixtures.json"), "utf8"));
    const current = bindProviderRetentionSources(legacy, corpus.sourceSkills);
    expect(await sourceMismatches(current, corpus.sourceSkills), "source preparation is separate from the provider retention oracle").toEqual([]);
    expect(current.resolveDigest("unlisted/path", "sha256:unlisted")).toBe("sha256:unlisted");
    const changed = structuredClone(legacy.manifest);
    const predecessor = changed.bindings.find(source => source.path === "skills/coordinate-subagents/SKILL.md");
    if (!predecessor) throw new Error("MISSING_PREDECESSOR_FIXTURE");
    predecessor.digest = "sha256:" + "0".repeat(64);
    expect(() => bindProviderRetentionSources({...legacy, manifest: changed}, corpus.sourceSkills))
      .toThrow("RETENTION_SOURCE_PREDECESSOR_MISMATCH:skills/coordinate-subagents/SKILL.md");
  });
  it("PRS-04/06 isolates the preparation cache and refuses live provider execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ags-provider-retention-"));
    try {
      const first = await readyMock(api, repo, path.join(root, "scope"), "retention-source-scope",
        {requests: 1, sourcePurpose: PROVIDER_RETENTION_PURPOSE});
      expect(first.prepared.sourcePurpose).toBe(PROVIDER_RETENTION_PURPOSE);
      expect(first.prepared.cases.every((item: {oracle: unknown}) => item.oracle === null)).toBe(true);
      expect(first.prepared.corpus.cases.some((item: {oracle: unknown}) => item.oracle !== null)).toBe(true);
      await expect(api.prepare(first.config)).rejects.toThrow("ORACLE_SOURCE_MISMATCH");
      let environmentReads = 0, sends = 0;
      await expect(api.run(first.config, {sourcePurpose: PROVIDER_RETENTION_PURPOSE, executionKind: "provider-live",
        env: new Proxy({}, {get() {environmentReads++; throw new Error("FORBIDDEN_ENVIRONMENT");}}),
        fetcher: async () => {sends++; throw new Error("FORBIDDEN_DISPATCH");}}))
        .rejects.toThrow("RETENTION_PURPOSE_REQUIRES_OFFLINE_MOCK");
      await expect(api.run(first.config, {sourcePurpose: PROVIDER_RETENTION_PURPOSE, executionKind: "offline-mock",
        env: new Proxy({}, {get() {environmentReads++; throw new Error("FORBIDDEN_ENVIRONMENT");}})}))
        .rejects.toThrow("RETENTION_PURPOSE_REQUIRES_OFFLINE_MOCK");
      expect(environmentReads).toBe(0);
      expect(sends).toBe(0);
    } finally {await preserveAndRemove(root);}
  });
  it("PRS-03 rejects changed current bytes and restored retired sources before environment access", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ags-provider-retention-"));
    const copiedRepo = path.join(root, "source-copy");
    const dependencyLink = path.join(copiedRepo, "node_modules");
    let linked = false;
    try {
      await mkdir(copiedRepo);
      for (const relative of new Set(["mcp-server/src/skill-classification", "skills", "tests/skill-classification/fixtures.json",
        "tests/skill-classification/evaluation.ts", "package.json",
        ...loadCurrentSourceBindings(repo).files.map(file => path.relative(repo, file))])) {
        const target = path.join(copiedRepo, relative);
        await mkdir(path.dirname(target), {recursive: true});
        await cp(path.join(repo, relative), target, {recursive: true});
      }
      await symlink(path.join(repo, "node_modules"), dependencyLink, process.platform === "win32" ? "junction" : "dir");
      linked = true;
      const first = await readyMock(api, copiedRepo, path.join(root, "scope"), "retention-source-drift",
        {requests: 1, sourcePurpose: PROVIDER_RETENTION_PURPOSE});
      for (const relative of ["skills/model-effort-advisor/SKILL.md", "skills/codex-token-usage-analyzer/SKILL.md"]) {
        const file = path.join(copiedRepo, relative);
        const original = await readFile(file).catch(error => {if (error.code === "ENOENT") return null; throw error;});
        let environmentReads = 0, sends = 0;
        try {
          await mkdir(path.dirname(file), {recursive: true});
          await writeFile(file, original === null ? "restored retired source\n" : Buffer.concat([original, Buffer.from("\n")]));
          await expect(api.run(first.config, {sourcePurpose: PROVIDER_RETENTION_PURPOSE, executionKind: "offline-mock",
            env: new Proxy({}, {get() {environmentReads++; throw new Error("FORBIDDEN_ENVIRONMENT");}}),
            fetcher: async () => {sends++; throw new Error("FORBIDDEN_DISPATCH");}})).rejects.toThrow("ORACLE_SOURCE_MISMATCH");
          expect(environmentReads).toBe(0);
          expect(sends).toBe(0);
        } finally {
          if (original === null) await rm(path.dirname(file), {recursive: true, force: true});
          else await writeFile(file, original);
        }
      }
    } finally {
      if (linked) await unlink(dependencyLink);
      await preserveAndRemove(root);
    }
  });
  it("keeps safe raw/usage across errors and omits unsafe or uninspectable bodies without resend", async () => {
    const started = performance.now();
    let phaseStarted = started;
    // Bounded fixture IDs and phases only: preserve the original 90s failure while locating its last unfinished phase.
    const observe = (caseId: string, phase: string, event: "begin" | "complete") => {
      const now = performance.now();
      if (event === "begin") phaseStarted = now;
      console.info(JSON.stringify({observation: "provider-retention-phase", caseId, phase, event,
        elapsedMs: Math.round(now - started), ...(event === "complete" ? {phaseElapsedMs: Math.round(now - phaseStarted)} : {})}));
    };
    const root = await mkdtemp(path.join(os.tmpdir(), "ags-provider-retention-"));
    try {
      const checks = await checkProviderObservationRetention(api, repo, root, observe);
      expect(checks).toEqual(["success", "http500", "revoked-after-fetch", "safe-chunk-read-error", "truncated-read-error",
        "invalid-score", "escaped-credential", "endpoint-echo", "overwritten-secret", "byte-cap", "invalid-utf8", "invalid-json", "timeout-safe-chunk"]);
      await writeFile(path.join(root, "checks.json"), JSON.stringify({status: "OFFLINE_PROVIDER_RETENTION_PASS", checks, actualApiCalls: 0}) + "\n", {flag: "wx"});
      console.info(JSON.stringify({status: "OFFLINE_PROVIDER_RETENTION_PASS", checks, actualApiCalls: 0}));
    }
    finally {
      observe("all", "cleanup", "begin");
      await preserveAndRemove(root);
      observe("all", "cleanup", "complete");
    }
  }, 90000);
});
