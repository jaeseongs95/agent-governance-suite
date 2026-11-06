import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import * as api from "./bootstrap.mjs";
import {checkProviderObservationRetention} from "./provider-observation-retention.mjs";
import {loadCurrentSourceBindings} from "../evaluation.js";

const repo = path.resolve(import.meta.dirname, "../../..");

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
  it("binds the current public sources before evaluating provider response retention", async () => {
    const current = loadCurrentSourceBindings(repo);
    const corpus = JSON.parse(await readFile(path.join(repo, "tests/skill-classification/fixtures.json"), "utf8"));
    const expected = new Map<string, string | null>(corpus.sourceSkills.map((source: {path: string; digest: string}) =>
      [source.path, current.resolveDigest(source.path, source.digest)]));
    for (const source of current.manifest.bindings) expected.set(source.path, source.digest);
    const mismatches = [];
    for (const [file, digest] of expected) {
      const bytes = await readFile(path.join(repo, file)).catch(error => {if (error.code === "ENOENT") return null; throw error;});
      const actual = bytes === null ? null : `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== digest) mismatches.push({file, expected: digest, actual});
    }
    expect(mismatches, "source preparation is separate from the provider retention oracle").toEqual([]);
  });
  it("keeps safe raw/usage across errors and omits unsafe or uninspectable bodies without resend", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ags-provider-retention-"));
    try {
      const checks = await checkProviderObservationRetention(api, repo, root);
      expect(checks).toEqual(["success", "http500", "revoked-after-fetch", "safe-chunk-read-error", "truncated-read-error",
        "invalid-score", "escaped-credential", "endpoint-echo", "overwritten-secret", "byte-cap", "invalid-utf8", "invalid-json", "timeout-safe-chunk"]);
      await writeFile(path.join(root, "checks.json"), JSON.stringify({status: "OFFLINE_PROVIDER_RETENTION_PASS", checks, actualApiCalls: 0}) + "\n", {flag: "wx"});
      console.info(JSON.stringify({status: "OFFLINE_PROVIDER_RETENTION_PASS", checks, actualApiCalls: 0}));
    }
    finally {await preserveAndRemove(root);}
  }, 90000);
});
