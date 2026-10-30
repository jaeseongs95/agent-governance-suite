import assert from "node:assert/strict";
import {cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {describe, expect, it} from "vitest";
import * as api from "./bootstrap.mjs";
import {readyMock, readyMockFromBinding, type FixtureBinding} from "./prepared-fixture.mjs";

const repo = path.resolve(import.meta.dirname, "../../..");
async function ownedRoot(action: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ags-fixture-reuse-"));
  try {await action(root);}
  finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("ags-fixture-reuse-"));
    await rm(root, {recursive: true, force: true});
  }
}

describe("bootstrap fixture binding reuse", () => {
  it("C1 keeps fixtures, current authority and actual request identities independent", async () => {
    await ownedRoot(async root => {
      const first = await readyMock(api, repo, path.join(root, "first"), "first", {requests: 1});
      const binding: FixtureBinding = Object.freeze({inventoryDigest: first.prepared.inventory.inventoryDigest,
        taxonomyRevision: first.prepared.inventory.taxonomyRevision});
      let unwantedPreparation = 0;
      const authoringApi = {...api, prepare: async () => {unwantedPreparation++; throw new Error("FIXTURE_MUST_NOT_PREPARE_OR_ADMIT");}};
      const createProfile = first.prepared.api.evaluationConfig.createProviderEvaluationConfiguration;
      const a = await readyMockFromBinding(authoringApi, repo, path.join(root, "a"), "seed-a", binding, createProfile, {requests: 1});
      const b = await readyMockFromBinding(authoringApi, repo, path.join(root, "b"), "seed-b", binding, createProfile, {requests: 1});
      expect(unwantedPreparation).toBe(0);
      expect(a).not.toBe(b);
      expect(a.profile).not.toBe(b.profile);
      expect(a.profile!.configuration).not.toBe(b.profile!.configuration);
      expect(a.evidence).not.toBe(b.evidence);
      expect(a.currentAuthority).not.toBe(b.currentAuthority);
      expect(a.outputDirectory).not.toBe(b.outputDirectory);
      expect(a.runId).toBe("seed-a");
      expect(b.runId).toBe("seed-b");
      const [pa, pb] = await Promise.all([api.prepare(a), api.prepare(b)]);
      expect(pa.requests[0]!.caseId).toBe(first.prepared.requests[0]!.caseId);
      expect(pa.requests[0]!.request.requestId).toBe(`seed-a/${pa.requests[0]!.caseId}`);
      expect(pb.requests[0]!.request.requestId).toBe(`seed-b/${pb.requests[0]!.caseId}`);
      expect(pa.requests[0]!.request.operationId).toBe(pa.requests[0]!.request.requestId);
      expect(pb.requests[0]!.request.operationId).toBe(pb.requests[0]!.request.requestId);
      expect(pa.requests[0]!.request.requestDigest).not.toBe(pb.requests[0]!.request.requestDigest);
      a.profile!.configuration.modelRevision = "mutated-a";
      expect(b.profile!.configuration.modelRevision).toBe("mock-model-revision");
      const authorityA = path.join(a.outputDirectory, a.currentAuthority!.reference.path);
      const authorityB = path.join(b.outputDirectory, b.currentAuthority!.reference.path);
      const revoked = JSON.parse(await readFile(authorityA, "utf8"));
      revoked.approved = false;
      await writeFile(authorityA, JSON.stringify(revoked));
      expect(JSON.parse(await readFile(authorityB, "utf8")).approved).toBe(true);
      expect(binding.inventoryDigest).toBe(first.prepared.inventory.inventoryDigest);
    });
  });

  it("C2 original run freshly rejects oracle, source and inventory changes after fixture seed", async () => {
    await ownedRoot(async root => {
      const copiedRepo = path.join(root, "source-copy");
      await mkdir(copiedRepo);
      for (const relative of ["mcp-server/src/skill-classification", "skills", "tests/skill-classification/fixtures.json",
        "tests/skill-classification/evaluation.ts", "tests/skill-classification/fixtures.source-successor.json",
        "tests/skill-classification/fixtures.unavailable-source-successor.json", "package.json"]) {
        const target = path.join(copiedRepo, relative);
        await mkdir(path.dirname(target), {recursive: true});
        await cp(path.join(repo, relative), target, {recursive: true});
      }
      const dependencyLink = path.join(copiedRepo, "node_modules");
      await symlink(path.join(repo, "node_modules"), dependencyLink, process.platform === "win32" ? "junction" : "dir");
      try {
        const first = await readyMock(api, copiedRepo, path.join(root, "first"), "copy-first", {requests: 1});
        const binding = Object.freeze({inventoryDigest: first.prepared.inventory.inventoryDigest,
          taxonomyRevision: first.prepared.inventory.taxonomyRevision});
        const corpusFile = path.join(copiedRepo, "tests/skill-classification/fixtures.json");
        const corpus = JSON.parse(await readFile(corpusFile, "utf8"));
        const sourceFile = path.join(copiedRepo, corpus.sourceSkills[0].path);
        assert(path.relative(copiedRepo, sourceFile) && !path.relative(copiedRepo, sourceFile).startsWith(".."));
        for (const [id, file, error] of [["oracle", corpusFile, "FROZEN_ORACLE_DIGEST_MISMATCH"],
          ["source", sourceFile, "ORACLE_SOURCE_MISMATCH"],
          ["source-metadata", path.join(copiedRepo, "skills/orchestrator/classification.json"), "ORACLE_SOURCE_MISMATCH"],
          ["inventory", path.join(copiedRepo, "skills/registry.json"), "INVENTORY_INCOMPLETE"],
          ["source-binding", path.join(copiedRepo, "tests/skill-classification/fixtures.unavailable-source-successor.json"), "CURRENT_SOURCE_BINDING_MANIFEST_MISMATCH"]] as const) {
          const config = await readyMockFromBinding(api, copiedRepo, path.join(root, id), `fresh-${id}`, binding,
            first.prepared.api.evaluationConfig.createProviderEvaluationConfiguration, {requests: 1});
          const bytes = await readFile(file);
          let environmentReads = 0, sends = 0;
          try {
            if (id === "source") await writeFile(file, Buffer.concat([bytes, Buffer.from("\n")]));
            else {
              const changed = JSON.parse(bytes.toString("utf8"));
              if (id === "oracle") changed.oracleDigest = "sha256:" + "0".repeat(64);
              else changed.schemaVersion = "invalid-registry-version";
              await writeFile(file, JSON.stringify(changed));
            }
            await expect(api.run(config, {executionKind: "offline-mock",
              env: new Proxy({}, {get() {environmentReads++; throw new Error("FORBIDDEN_ENVIRONMENT");}}),
              fetcher: async () => {sends++; throw new Error("FORBIDDEN_DISPATCH");}})).rejects.toThrow(error);
            expect(environmentReads).toBe(0);
            expect(sends).toBe(0);
          } finally {await writeFile(file, bytes);}
        }
      } finally {await unlink(dependencyLink);}
    });
  });

  it("C3 original admission rereads each fixture authority and evidence before environment access", async () => {
    await ownedRoot(async root => {
      const first = await readyMock(api, repo, path.join(root, "first"), "authority-first", {requests: 1});
      const binding = Object.freeze({inventoryDigest: first.prepared.inventory.inventoryDigest,
        taxonomyRevision: first.prepared.inventory.taxonomyRevision});
      for (const id of ["authority", "evidence"] as const) {
        const config = await readyMockFromBinding(api, repo, path.join(root, id), `current-${id}`, binding,
          first.prepared.api.evaluationConfig.createProviderEvaluationConfiguration, {requests: 1});
        const file = path.join(config.outputDirectory, id === "authority" ? config.currentAuthority!.reference.path : config.evidence.route!.path);
        await writeFile(file, Buffer.concat([await readFile(file), Buffer.from("\n")]));
        let environmentReads = 0, sends = 0;
        const result = await api.run(config, {executionKind: "offline-mock",
          env: new Proxy({}, {get() {environmentReads++; throw new Error("FORBIDDEN_ENVIRONMENT");}}),
          fetcher: async () => {sends++; throw new Error("FORBIDDEN_DISPATCH");}}).catch(error => ({status: "UNEXPECTED_THROW" as const, error}));
        expect(result.status).toBe("BLOCKED");
        if (result.status !== "BLOCKED") throw new Error("Expected current state refusal");
        expect(result.blocked).toContain(id === "authority" ? "CURRENT_AUTHORITY_CHANGED" : "EVIDENCE_STALE:route");
        expect(environmentReads).toBe(0);
        expect(sends).toBe(0);
      }
    });
  });
});
