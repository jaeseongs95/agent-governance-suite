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
const semanticDigest = "sha256:3fefd6ced872d836c615d4e8d012d6dbe07059122fb9cdc4c659f715c1884deb";
const historicalSidecarDigest = "sha256:1994adee624778e58037701ab6f0eff8eb45e31df99e5e860a9542db2f815642";
const predecessor = {
  "path": "tests/skill-classification/fixtures.json",
  "gitBlob": "ef36645f7f457bbd3714dc9c8869f15e0f25337e",
  "bytes": 142488,
  "digest": "sha256:a7b6c5ea425a24bf53ae3178ed7c0afb0dd783662404fe3194c462aff908f3f9",
  "fixtureRevision": "ags-classification-seq7-oracle-v1-source-binding-r02",
  "oracleRevision": "pre-live-source-reviewed-v1-source-binding-r02",
  "oracleDigest": "sha256:da3ee5b3b718d3b0d4a19d7dadd279f721fd88c6944121ef8848ffbb316a2a10"
};
const bindings = [
  {
    "skillId": "blocker-diagnostician",
    "path": "skills/blocker-diagnostician/SKILL.md",
    "previousDigest": "sha256:5cc3e57aa82d28a7087717c13f39661911cefc6ec20d9ae9387a49bd1fadfb2e",
    "digest": "sha256:0b2ed15e57c2c344661a3ae64073181d6f7b8940b7ef4e315daf010629c7f0de"
  },
  {
    "skillId": "independent-audit-gate",
    "path": "skills/independent-audit-gate/SKILL.md",
    "previousDigest": "sha256:6d46d2eda33237b9e67bb0f44d102a22ef24154bbef3478671b6ed863b6c7bd8",
    "digest": "sha256:26086ee54f0d49b1bc861ec27200d26150737d9772773e07139ae59f56404e29"
  },
  {
    "skillId": "model-effort-advisor",
    "path": "skills/model-effort-advisor/SKILL.md",
    "previousDigest": "sha256:55d965086eab2ac7fe8acd34d32a520a91ed465e92bfe8b73629b04ab8d61106",
    "digest": "sha256:fa84d128bf1d9a6742b74f13080db98f304803e84168b8de39a9e120a01a9a6a"
  },
  {
    "skillId": "orchestrator",
    "path": "skills/orchestrator/SKILL.md",
    "previousDigest": "sha256:1cfaf8503aacae72fb7e2591e708bea507848ae338e21855c15e4b1ccb635cd1",
    "digest": "sha256:b90c19a956f4dd3b239e4f4a527ebea319128dbae239018f8f3b0b5445cc43ac"
  },
  {
    "skillId": "ponytail",
    "path": "skills/ponytail/SKILL.md",
    "previousDigest": "sha256:953fd16ff07c23b9481e9bdfca12dbb0d115422ebdbd6626bae6b574838a777c",
    "digest": "sha256:907667b8b625eab0438b462a4737a056e3833f972c66e432817a12e6f643ac76"
  }
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
  expect(original.predecessor.gitBlob).toBe("26b1fa1526f1e6bd38768409e0fa77943a4a4db8");
  expect(original.predecessor.bytes).toBe(142450);
  expect(original.predecessor.digest).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
  expect(original.predecessor.oracleDigest).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
  expect(original.semanticProjection.digest).toBe("sha256:8069d5479dff519557e58ec2589fb4ef9dcb899213582ff419fca83791ee7422");
  expect(current.fixtureRevision).toBe("ags-classification-governance-source-binding-r03");
  expect(current.oracleRevision).toBe("pre-live-governance-source-reviewed-r03");
  expect(current.sourceBindingRevision).toBe("pre-live-source-binding-3");
  expect(current.fixtureRevision).toBe(successor.successor.fixtureRevision);
  expect(current.oracleRevision).toBe(successor.successor.oracleRevision);
  expect(successor.semanticProjection.digest).toBe(semanticDigest);
  expect(hash(JSON.stringify(semantics(current)))).toBe(semanticDigest);
  expect(current.cases).toHaveLength(39);
  expect(current.cases.filter((row: {oracle: unknown}) => row.oracle !== null)).toHaveLength(18);
  expect(current.cases.filter((row: {publicSynthetic: boolean; originalPrompt: unknown}) => row.publicSynthetic && typeof row.originalPrompt === "string" && row.originalPrompt.length > 0)).toHaveLength(21);
  expect(current.status).toBe("NOT_RUN");
  expect(oracleDigest(current)).toBe(current.oracleDigest);
  expect(current.oracleDigest).toBe(successor.successor.oracleDigest);
});
it("binds exactly the five selected current sources across global and per-case evidence", () => {
  expect(successor.bindings).toEqual(bindings);
  expect(successor.semanticProjection.omittedRevisionFields).toEqual(["fixtureRevision", "oracleRevision", "oracleDigest", "sourceBindingRevision"]);
  expect(successor.semanticProjection.omittedDigestPaths).toEqual(bindings.map(({skillId,path}) => ({skillId,path})));
  let references = 0;
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const binding = bindings.find(item => item.skillId === row.skillId && item.path === row.path);
    if (binding && "digest" in row) {expect(row.digest).toBe(binding.digest); references++;}
    for (const child of Object.values(row)) walk(child);
  };
  walk(current);
  expect(references).toBe(38);
  expect(references).toBe(successor.reboundReferences);
  for (const binding of bindings) {
    expect(hash(readFileSync(path.join(root,binding.path)))).toBe(binding.digest);
    expect(binding.digest).not.toBe(binding.previousDigest);
  }
});
