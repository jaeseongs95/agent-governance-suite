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
const r06SidecarDigest = "sha256:ea2f56ae4bda02a8d96277a482c948a773357007d1765e5fe1e4cf7fea943ada";
const r07SidecarDigest = "sha256:9ed472c1bbca0945b6133f8d1fe66e1aefe12b97b0c20b640ddeb58d1acfc624";
const historicalSidecarDigest = "sha256:28f4840754da38b16bcf8165186271c77b4a883dd8cafa8e97aa686d60d9a075";
const semanticDigest = "sha256:9b9fe0389d497d4b25eac1998cb091d269e7612a92e57912a2cdc8279d8d6542";
const bindings = [
  {skillId: "acceptance-evidence-validator", path: "skills/acceptance-evidence-validator/SKILL.md", previousDigest: "sha256:1ed22041c60ebbb2af76a6a90deca619301aa9d91cef72c3f6bba090e6e4d109", digest: "sha256:934cc5ef2e5d187c31e2eef086c61ff03b5e76cec50bf82be648eda87e228fda"},
  {skillId: "coordinate-subagents", path: "skills/coordinate-subagents/SKILL.md", previousDigest: "sha256:b8f988f615aa7a2c60abe5c8e1546d7bbf9ce5847ee67aa2be887db3b7d181e0", digest: "sha256:6ba85d995e098afe3cdeb8d20a0b130d383447a5ac6d1781c87e6b52461a7e2e"},
  {skillId: "cs-engineering", path: "skills/cs-engineering/SKILL.md", previousDigest: "sha256:aa5133cba109cb65e867f75e8a6d3a6602c49d72dd4fb5676cab3ddf0e2d0646", digest: "sha256:435939d54f74626d07cbfbedd87fcb1a8e13338bc6c0e46d5233d80a7733d681"},
  {skillId: "independent-audit-gate", path: "skills/independent-audit-gate/SKILL.md", previousDigest: "sha256:26086ee54f0d49b1bc861ec27200d26150737d9772773e07139ae59f56404e29", digest: "sha256:abb5d4c1fa0607851018cd6f6a2f3ecf314cc829149ea0d15c5474ed9afd2a18"},
  {skillId: "independent-deliberation-panel", path: "skills/independent-deliberation-panel/SKILL.md", previousDigest: "sha256:899e5af89ad4621107a33ba101cc63ad7ba6ad4d585438e8cb187c3bfe76c3ab", digest: "sha256:eb21677b0f377116250691a8cf84b44ec853c4de9c56e27ea17585016a151f54"},
  {skillId: "mutation-risk-preflight", path: "skills/mutation-risk-preflight/SKILL.md", previousDigest: "sha256:eb02732691b63ca085ff8bca59854a134a8711ac7788888f9f3c6e4324474cbe", digest: "sha256:9aa4e7cb143bb0ad9ffc5f6c03ed32331e1f14562cd4322fab0e36cd29c21ce1"},
  {skillId: "orchestrator", path: "skills/orchestrator/SKILL.md", previousDigest: "sha256:e5f2e1cf5bbfa49821a5aad81ad83b68cf5cae3ec75c92050a8a4cd13b56be45", digest: "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4"},
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
  expect(successor.predecessor).toEqual({
    path: "tests/skill-classification/fixtures.json",
    gitRevision: "f555748df4f4d74f2cb5d34454c7b3494c161186",
    gitBlob: "b7d4d07d4ec603fad9d5052f7986f799316d6e9f",
    bytes: 142487,
    digest: "sha256:7ef33ec877a2496846a8d9333fb302eba73b467f7be99ccc7e6224026b864159",
    fixtureRevision: "ags-classification-resource-impact-source-binding-r07",
    oracleRevision: "pre-live-resource-impact-source-reviewed-r07",
    oracleDigest: "sha256:45e034a812726867412b6ea78261c0dd98232679b2f66f9c265c6122e28cce33",
  });
  expect(successor.historicalSuccessor.digest).toBe(r07SidecarDigest);
  expect(hash(JSON.stringify(successor.historicalSuccessor.document, null, 2) + "\n")).toBe(r07SidecarDigest);
  const r07 = successor.historicalSuccessor.document;
  expect(r07.successor.fixtureRevision).toBe("ags-classification-resource-impact-source-binding-r07");
  expect(r07.historicalSuccessor.digest).toBe(r06SidecarDigest);
  expect(hash(JSON.stringify(r07.historicalSuccessor.document, null, 2) + "\n")).toBe(r06SidecarDigest);
  const r06 = r07.historicalSuccessor.document;
  expect(r06.successor.fixtureRevision).toBe("ags-classification-midtask-source-binding-r06");
  expect(r06.historicalSuccessor.digest).toBe(historicalSidecarDigest);
  expect(hash(JSON.stringify(r06.historicalSuccessor.document, null, 2) + "\n")).toBe(historicalSidecarDigest);
  const original = r06.historicalSuccessor.document;
  expect(original.predecessor.gitBlob).toBe("af8424b81e3fbc495cbd5f628d3e3d2157e705a2");
  expect(original.predecessor.bytes).toBe(142477);
  expect(original.predecessor.digest).toBe("sha256:49d327a6dca9557312d90014410702f8466e839175b3187bc91693b6cccd4789");
  expect(original.predecessor.oracleDigest).toBe("sha256:96a7c48283c995dd79c662860b179298bd99d474c899d58820de17d7b8770239");
  expect(original.semanticProjection.digest).toBe("sha256:6700d30def96ecbc7869f52dd5ab05e417d3b6ef42dfa3e390361054ff8ad2aa");
  expect(original.historicalSuccessor.digest).toBe("sha256:69ef37b636e35bfdce77103cbe84015c0e2e9482a41e46059d89ac557a8717f7");
  expect(original.successor.fixtureRevision).toBe(predecessor.fixtureRevision);
  expect(original.successor.oracleDigest).toBe(predecessor.oracleDigest);
  expect(current.fixtureRevision).toBe("ags-classification-governance-behavior-source-binding-r09");
  expect(current.oracleRevision).toBe("pre-live-governance-behavior-source-reviewed-r09");
  expect(current.sourceBindingRevision).toBe("pre-live-source-binding-9");
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
  expect(successor.governanceBehaviorSourceSuccessor.sourceBaseRevision).toBe("f555748df4f4d74f2cb5d34454c7b3494c161186");
  expect(successor.governanceBehaviorSourceSuccessor.predecessor).toEqual(successor.predecessor);
  expect(successor.governanceBehaviorSourceSuccessor.sourceBindings).toEqual([
    {path: "skills/orchestrator/SKILL.md", previousDigest: "sha256:e5f2e1cf5bbfa49821a5aad81ad83b68cf5cae3ec75c92050a8a4cd13b56be45", digest: "sha256:082e2fe237d22455ccbcedb3f4b26dcaa0b1a78f5f552011e3ac36515d21653b", bytes: 9285},
    {path: "skills/orchestrator/classification.json", previousDigest: "sha256:6d33ef4bc3ae5daa8c15867f03dbdaf4c0cebf76fcfbd872ca1b8c3b6636baad", digest: "sha256:81ac5daaa54a6fc6947ba5e805bf7c1d3e4c061dd473be820f4a553a762dd577", bytes: 4577},
  ]);
  expect(successor.governanceBehaviorSourceSuccessor.reboundReferences).toBe(17);
  expect(successor.governanceBehaviorSourceSuccessor.labelChanges).toEqual([]);
  expect(successor.governanceBehaviorSourceSuccessor.modelBehavior).toBe("NOT_RUN");
  const r09 = successor.orchestratorInvocationSourceSuccessor;
  expect(r09.revision).toBe("orchestrator-invocation-source-binding-r09");
  expect(r09.sourceBaseRevision).toBe("9d393393e68c6ee72894599299051e1cbff41b95");
  expect(r09.predecessor).toEqual({"path": "tests/skill-classification/fixtures.json", "gitRevision": "9d393393e68c6ee72894599299051e1cbff41b95", "gitBlob": "87333e8e281d06d26ce88ceac2b042043eac282a", "bytes": 142495, "digest": "sha256:d3490862893ee85f13dbee39ad992498bf7a76360c898d30d8089e5e485c1b88", "fixtureRevision": "ags-classification-governance-behavior-source-binding-r08", "oracleRevision": "pre-live-governance-behavior-source-reviewed-r08", "oracleDigest": "sha256:e48f0d37e8675f046a00648451fc3086753af97d663ca4a0aa18b8fdad386666", "sourceBindingRevision": "pre-live-source-binding-8"});
  expect(r09.predecessorSidecar).toEqual({"path": "tests/skill-classification/fixtures.source-successor.json", "gitRevision": "9d393393e68c6ee72894599299051e1cbff41b95", "gitBlob": "dd74211fc527015a9554af2c1f1af7d89f02ff68", "bytes": 40883, "digest": "sha256:2d8192e1ce5793d20bfe6fb6839e448141c40ea0d520fd9da3a1a414a13ebed1"});
  expect(r09.sourceBindings).toEqual([{"path": "skills/orchestrator/SKILL.md", "previousDigest": "sha256:082e2fe237d22455ccbcedb3f4b26dcaa0b1a78f5f552011e3ac36515d21653b", "digest": "sha256:5f2cf07a358914cd068a90cf6eb7fe3bbf549a7fc08e47dfc6daecefeabd44f4", "bytes": 9945}, {"path": "skills/orchestrator/classification.json", "previousDigest": "sha256:81ac5daaa54a6fc6947ba5e805bf7c1d3e4c061dd473be820f4a553a762dd577", "digest": "sha256:44d66bda8d2c80034d3f881ff3f12de6d628bd4d8ce850fd49718df656aa95d2", "bytes": 4577}]);
  expect(r09.reboundReferences).toBe(17);
  expect(r09.classificationReferences).toBe(18);
  expect(r09.labelChanges).toEqual([]);
  expect(r09.modelBehavior).toBe("NOT_RUN");
  for (const binding of successor.governanceBehaviorSourceSuccessor.sourceBindings) {
    expect(r09.sourceBindings.find((current: {path: string}) => current.path === binding.path)?.previousDigest).toBe(binding.digest);
  }
  for (const binding of r09.sourceBindings) {
    expect(hash(readFileSync(path.join(root, binding.path)))).toBe(binding.digest);
  }
  expect(r06.midtaskSourceSuccessor.predecessor).toEqual({
    gitRevision: "45556669124efc64151be21be9958463e1f18d40",
    gitBlob: "2078c29de99d2c5a2dc1693b9c68da9cac395bac",
    digest: "sha256:3c7c2159bbaa74521c5c5aefbae21710a7a507a6235315608ec941fb1b1294f1", bytes: 142481,
    fixtureRevision: "ags-classification-skill-policy-source-binding-r05",
    oracleRevision: "pre-live-skill-policy-source-reviewed-r05",
    oracleDigest: "sha256:307f07d6f78cba04e1f606f680e6609b9a17f22f499b802f1b0cf46329a1bd2e",
  });
  expect(r06.midtaskSourceSuccessor.reboundReferences).toBe(17);
  expect(r06.midtaskSourceSuccessor.labelChanges).toEqual([]);
  expect(r06.midtaskSourceSuccessor.modelBehavior).toBe("NOT_RUN");
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
