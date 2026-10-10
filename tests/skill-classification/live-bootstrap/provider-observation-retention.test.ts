import {cp, mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import * as api from "./bootstrap.mjs";
import {checkProviderObservationRetention} from "./provider-observation-retention.mjs";

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
  it("keeps safe raw/usage across errors and omits unsafe or uninspectable bodies without resend", async () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    const root = await mkdtemp(path.join(os.tmpdir(), "ags-provider-retention-"));
    try {
      const checks = await checkProviderObservationRetention(api, repo, root);
      expect(checks).toHaveLength(13);
      await writeFile(path.join(root, "checks.json"), JSON.stringify({status: "OFFLINE_PROVIDER_RETENTION_PASS", checks, actualApiCalls: 0}) + "\n", {flag: "wx"});
      console.info(JSON.stringify({status: "OFFLINE_PROVIDER_RETENTION_PASS", checks, actualApiCalls: 0}));
    }
    finally {await preserveAndRemove(root);}
  }, 90000);
});
