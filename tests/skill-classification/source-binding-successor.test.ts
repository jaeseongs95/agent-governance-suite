import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {oracleDigest} from "./evaluation.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const current = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const successor = JSON.parse(readFileSync(new URL("./fixtures.source-successor.json", import.meta.url), "utf8"));
const hash = (bytes: string | Buffer) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
// Explicit authoring pins from exact predecessor Git bytes; tests never regenerate expected values.
const predecessor = {
  path: "tests/skill-classification/fixtures.json",
  gitBlob: "f7aedbf77d1547cb49f75ea391c152b3a6172c71",
  bytes: 142465,
  digest: "sha256:7a69d6681e02aa1ce4925e0b3b3eb421cde064dd5a578d16af190e07db24f57b",
  fixtureRevision: "ags-classification-host-source-binding-r04",
  oracleRevision: "pre-live-host-source-reviewed-r04",
  oracleDigest: "sha256:92b7f4d74d88ae5ebae6de59891e7050bec6dacda92ab02e209216bb26d66ee8"
};
const historicalSidecarDigest = "sha256:28f4840754da38b16bcf8165186271c77b4a883dd8cafa8e97aa686d60d9a075";
const semanticDigest = "sha256:9b9fe0389d497d4b25eac1998cb091d269e7612a92e57912a2cdc8279d8d6542";
const bindings = [
  {skillId: "acceptance-evidence-validator", path: "skills/acceptance-evidence-validator/SKILL.md", previousDigest: "sha256:1ed22041c60ebbb2af76a6a90deca619301aa9d91cef72c3f6bba090e6e4d109", digest: "sha256:934cc5ef2e5d187c31e2eef086c61ff03b5e76cec50bf82be648eda87e228fda"},
  {skillId: "coordinate-subagents", path: "skills/coordinate-subagents/SKILL.md", previousDigest: "sha256:b8f988f615aa7a2c60abe5c8e1546d7bbf9ce5847ee67aa2be887db3b7d181e0", digest: "sha256:6ba85d995e098afe3cdeb8d20a0b130d383447a5ac6d1781c87e6b52461a7e2e"},
  {skillId: "cs-engineering", path: "skills/cs-engineering/SKILL.md", previousDigest: "sha256:aa5133cba109cb65e867f75e8a6d3a6602c49d72dd4fb5676cab3ddf0e2d0646", digest: "sha256:435939d54f74626d07cbfbedd87fcb1a8e13338bc6c0e46d5233d80a7733d681"},
  {skillId: "independent-audit-gate", path: "skills/independent-audit-gate/SKILL.md", previousDigest: "sha256:26086ee54f0d49b1bc861ec27200d26150737d9772773e07139ae59f56404e29", digest: "sha256:abb5d4c1fa0607851018cd6f6a2f3ecf314cc829149ea0d15c5474ed9afd2a18"},
  {skillId: "independent-deliberation-panel", path: "skills/independent-deliberation-panel/SKILL.md", previousDigest: "sha256:899e5af89ad4621107a33ba101cc63ad7ba6ad4d585438e8cb187c3bfe76c3ab", digest: "sha256:eb21677b0f377116250691a8cf84b44ec853c4de9c56e27ea17585016a151f54"},
  {skillId: "mutation-risk-preflight", path: "skills/mutation-risk-preflight/SKILL.md", previousDigest: "sha256:eb02732691b63ca085ff8bca59854a134a8711ac7788888f9f3c6e4324474cbe", digest: "sha256:9aa4e7cb143bb0ad9ffc5f6c03ed32331e1f14562cd4322fab0e36cd29c21ce1"},
  {skillId: "orchestrator", path: "skills/orchestrator/SKILL.md", previousDigest: "sha256:b90c19a956f4dd3b239e4f4a527ebea319128dbae239018f8f3b0b5445cc43ac", digest: "sha256:b44340396bf55691bbd5e88d913f660b6aef9cedb3d9e6c27707cef904d68234"},
  {skillId: "ponytail", path: "skills/ponytail/SKILL.md", previousDigest: "sha256:907667b8b625eab0438b462a4737a056e3833f972c66e432817a12e6f643ac76", digest: "sha256:2ce28db45c1a84e63fa2af7079e58a3803fc26b16ab7073436efd55b1e1214f9"},
  {skillId: "task-contract", path: "skills/task-contract/SKILL.md", previousDigest: "sha256:0482c8aa36c95ddd5b7d68aa5924840341a64bfb05c39c7dcb112c8df1fb4100", digest: "sha256:92cf19444e6c97b1d1d017f8eed481135d708095d89411668ab215123d1266aa"}
];
const isolated = successor.isolatedHotfixSourceSuccessor;
const isolatedBinding = {"skillId": "orchestrator", "path": "skills/orchestrator/SKILL.md", "previousDigest": "sha256:b44340396bf55691bbd5e88d913f660b6aef9cedb3d9e6c27707cef904d68234", "digest": "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4"};
function semantics(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map(child => semantics(child, depth + 1));
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const bound = bindings.some(binding => binding.skillId === row.skillId && binding.path === row.path);
    return Object.fromEntries(Object.entries(row)
      .filter(([key]) => !(bound && key === "digest") && !(depth === 0 && ["fixtureRevision", "oracleRevision", "oracleDigest", "sourceBindingRevision"].includes(key)))
      .map(([key, child]) => [key, semantics(child, depth + 1)]));
  }
  return value;
}
it("preserves predecessor history and all frozen 39/18/21 semantics in a distinct source revision", () => {
  expect(successor.predecessor).toEqual(predecessor);
  expect(successor.historicalSuccessor.digest).toBe(historicalSidecarDigest);
  expect(hash(JSON.stringify(successor.historicalSuccessor.document, null, 2) + "\n")).toBe(historicalSidecarDigest);
  const original = successor.historicalSuccessor.document;
  expect(original.predecessor.gitBlob).toBe("af8424b81e3fbc495cbd5f628d3e3d2157e705a2");
  expect(original.predecessor.bytes).toBe(142477);
  expect(original.predecessor.digest).toBe("sha256:49d327a6dca9557312d90014410702f8466e839175b3187bc91693b6cccd4789");
  expect(original.predecessor.oracleDigest).toBe("sha256:96a7c48283c995dd79c662860b179298bd99d474c899d58820de17d7b8770239");
  expect(original.semanticProjection.digest).toBe("sha256:6700d30def96ecbc7869f52dd5ab05e417d3b6ef42dfa3e390361054ff8ad2aa");
  expect(original.historicalSuccessor.digest).toBe("sha256:69ef37b636e35bfdce77103cbe84015c0e2e9482a41e46059d89ac557a8717f7");
  expect(original.successor.fixtureRevision).toBe(predecessor.fixtureRevision);
  expect(original.successor.oracleDigest).toBe(predecessor.oracleDigest);
  expect(current.fixtureRevision).toBe("ags-classification-d0352-isolated-source-binding-r10");
  expect(current.oracleRevision).toBe("pre-live-d0352-isolated-source-reviewed-r10");
  expect(current.sourceBindingRevision).toBe("pre-live-source-binding-10-isolated");
  expect(current.fixtureRevision).toBe(isolated.successor.fixtureRevision);
  expect(current.oracleRevision).toBe(isolated.successor.oracleRevision);
  expect(successor.semanticProjection.digest).toBe(semanticDigest);
  expect(hash(JSON.stringify(semantics(current)))).toBe(semanticDigest);
  expect(current.cases).toHaveLength(39);
  expect(current.cases.filter((row: {oracle: unknown}) => row.oracle !== null)).toHaveLength(18);
  expect(current.cases.filter((row: {publicSynthetic: boolean; originalPrompt: unknown}) => row.publicSynthetic && typeof row.originalPrompt === "string" && row.originalPrompt.length > 0)).toHaveLength(21);
  expect(current.status).toBe("NOT_RUN");
  expect(successor.review.labelChanges).toEqual([]);
  expect(oracleDigest(current)).toBe(current.oracleDigest);
  expect(current.oracleDigest).toBe(isolated.successor.oracleDigest);
  expect(current.oracleDigest).not.toBe(predecessor.oracleDigest);
});
it("binds exactly the nine changed skill policy sources across global and per-case evidence", () => {
  expect(successor.bindings).toEqual(bindings);
  expect(successor.semanticProjection.omittedRevisionFields).toEqual(["fixtureRevision", "oracleRevision", "oracleDigest", "sourceBindingRevision"]);
  expect(successor.semanticProjection.omittedDigestPaths).toEqual(bindings.map(({skillId, path}) => ({skillId, path})));
  let references = 0;
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const binding = bindings.find(item => item.skillId === row.skillId && item.path === row.path);
    if (binding && "digest" in row) {
      const expected = binding.skillId === "orchestrator" ? isolatedBinding : binding;
      expect(row.digest).toBe(expected.digest); references++;
    }
    for (const child of Object.values(row)) walk(child);
  };
  walk(current);
  expect(references).toBe(58);
  expect(references).toBe(successor.reboundReferences);
  for (const binding of bindings) {
    const expected = binding.skillId === "orchestrator" ? isolatedBinding : binding;
    expect(hash(readFileSync(path.join(root, binding.path)))).toBe(expected.digest);
    expect(binding.digest).not.toBe(binding.previousDigest);
  }
});

it("preserves the exact 838 predecessor and binds only the isolated D352 successor", () => {
  expect(isolated.revision).toBe("d0352-isolated-source-binding-r10");
  expect(isolated.role).toBe("source-binding-only-no-evaluation-authority");
  expect(isolated.baseCommit).toBe("838cae9dfb97fb1cbf8a4f3779b93e2464e3e56b");
  expect(isolated.predecessor).toEqual({"path": "tests/skill-classification/fixtures.json", "gitBlob": "2078c29de99d2c5a2dc1693b9c68da9cac395bac", "bytes": 142481, "digest": "sha256:3c7c2159bbaa74521c5c5aefbae21710a7a507a6235315608ec941fb1b1294f1", "fixtureRevision": "ags-classification-skill-policy-source-binding-r05", "oracleRevision": "pre-live-skill-policy-source-reviewed-r05", "oracleDigest": "sha256:307f07d6f78cba04e1f606f680e6609b9a17f22f499b802f1b0cf46329a1bd2e", "sourceBindingRevision": "pre-live-source-binding-5"});
  expect(isolated.predecessorSidecar).toEqual({"path": "tests/skill-classification/fixtures.source-successor.json", "gitBlob": "b4900c047dc76c218f845a002ccc79b60fe97a6c", "bytes": 18528, "digest": "sha256:f157b2fdf68a2bb149b6db276e73141a8c75aacbdde20f602f9bf4874e6c76f0"});
  expect(isolated.successor).toEqual({"fixtureRevision": "ags-classification-d0352-isolated-source-binding-r10", "oracleRevision": "pre-live-d0352-isolated-source-reviewed-r10", "oracleDigest": "sha256:45feee54e9256ad16b66b12464c37bab73af14e6fa211d21bfce87b7300c9c43", "sourceBindingRevision": "pre-live-source-binding-10-isolated"});
  expect(isolated.bindings).toEqual([isolatedBinding]);
  expect(isolated.reboundReferences).toBe(17);
  expect(isolated.review.labelChanges).toEqual([]);
  expect(isolated.review.modelBehavior).toBe("NOT_RUN");
  expect(successor.successor).toEqual({
    fixtureRevision: isolated.predecessor.fixtureRevision,
    oracleRevision: isolated.predecessor.oracleRevision,
    oracleDigest: isolated.predecessor.oracleDigest
  });
  const priorSidecar: Record<string, unknown> = {...successor};
  delete priorSidecar.isolatedHotfixSourceSuccessor;
  expect(hash(JSON.stringify(priorSidecar, null, 2) + "\n")).toBe(isolated.predecessorSidecar.digest);
  const priorFixture = JSON.parse(JSON.stringify(current));
  let references = 0;
  const restore = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (row.skillId === isolatedBinding.skillId && row.path === isolatedBinding.path && "digest" in row) {
      expect(row.digest).toBe(isolatedBinding.digest);
      row.digest = isolatedBinding.previousDigest;
      references++;
    }
    for (const child of Object.values(row)) restore(child);
  };
  restore(priorFixture);
  for (const key of ["fixtureRevision", "oracleRevision", "oracleDigest", "sourceBindingRevision"]) {
    priorFixture[key] = isolated.predecessor[key];
  }
  expect(references).toBe(17);
  expect(hash(JSON.stringify(priorFixture, null, 2) + "\n")).toBe(isolated.predecessor.digest);
  expect(oracleDigest(priorFixture)).toBe(isolated.predecessor.oracleDigest);
  expect(hash(JSON.stringify(semantics(priorFixture)))).toBe(semanticDigest);
  expect(isolated.sourceFiles).toEqual([{"path": "skills/orchestrator/SKILL.md", "bytes": 9945, "digest": "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4"}, {"path": "skills/orchestrator/classification.json", "bytes": 4577, "digest": "sha256:44d66bda8d2c80034d3f881ff3f12de6d628bd4d8ce850fd49718df656aa95d2"}, {"path": "skills/orchestrator/references/entry-details.md", "bytes": 22130, "digest": "sha256:86af016cfc8399a656181f5253189c098b53434aaa8b7d4fd1353d586248333f"}, {"path": "skills/orchestrator/references/engineering-practices/cli.md", "bytes": 9231, "digest": "sha256:c23134f4ebce972f891e7b7bf93f9ac24a5c340e856e3f1192e58fb33aff3b2b"}]);
  for (const source of isolated.sourceFiles) {
    const bytes = readFileSync(path.join(root, source.path));
    expect(bytes.length).toBe(source.bytes);
    expect(hash(bytes)).toBe(source.digest);
  }
});
