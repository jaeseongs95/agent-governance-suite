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
  expect(current.fixtureRevision).toBe("ags-classification-skill-policy-source-binding-r05");
  expect(current.oracleRevision).toBe("pre-live-skill-policy-source-reviewed-r05");
  expect(current.sourceBindingRevision).toBe("pre-live-source-binding-5");
  expect(current.fixtureRevision).toBe(successor.successor.fixtureRevision);
  expect(current.oracleRevision).toBe(successor.successor.oracleRevision);
  expect(successor.semanticProjection.digest).toBe(semanticDigest);
  expect(hash(JSON.stringify(semantics(current)))).toBe(semanticDigest);
  expect(current.cases).toHaveLength(39);
  expect(current.cases.filter((row: {oracle: unknown}) => row.oracle !== null)).toHaveLength(18);
  expect(current.cases.filter((row: {publicSynthetic: boolean; originalPrompt: unknown}) => row.publicSynthetic && typeof row.originalPrompt === "string" && row.originalPrompt.length > 0)).toHaveLength(21);
  expect(current.status).toBe("NOT_RUN");
  expect(successor.review.labelChanges).toEqual([]);
  expect(oracleDigest(current)).toBe(current.oracleDigest);
  expect(current.oracleDigest).toBe(successor.successor.oracleDigest);
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
    if (binding && "digest" in row) {expect(row.digest).toBe(binding.digest); references++;}
    for (const child of Object.values(row)) walk(child);
  };
  walk(current);
  expect(references).toBe(58);
  expect(references).toBe(successor.reboundReferences);
  for (const binding of bindings) {
    expect(hash(readFileSync(path.join(root, binding.path)))).toBe(binding.digest);
    expect(binding.digest).not.toBe(binding.previousDigest);
  }
});
