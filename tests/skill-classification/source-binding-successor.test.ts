import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {oracleDigest} from "./evaluation.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const current = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const successor = JSON.parse(readFileSync(new URL("./fixtures.source-successor.json", import.meta.url), "utf8"));
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
// Independently frozen from the original Git fixture; author evidence retains the byte comparison.
const originalSemanticDigest = "sha256:8069d5479dff519557e58ec2589fb4ef9dcb899213582ff419fca83791ee7422";

function semantics(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map(child => semantics(child, depth + 1));
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const bound = (row.skillId === "ponytail" && row.path === "skills/ponytail/SKILL.md")
      || (row.skillId === "orchestrator" && row.path === "skills/orchestrator/SKILL.md");
    return Object.fromEntries(Object.entries(row)
      .filter(([key]) => !(bound && key === "digest") && !(depth === 0 && ["fixtureRevision", "oracleRevision", "oracleDigest"].includes(key)))
      .map(([key, child]) => [key, semantics(child, depth + 1)]));
  }
  return value;
}

it("preserves frozen case/oracle semantics in a distinct binding revision without historical Git objects", () => {
  expect(successor.predecessor.gitBlob).toBe("26b1fa1526f1e6bd38768409e0fa77943a4a4db8");
  expect(successor.predecessor.bytes).toBe(142450);
  expect(successor.predecessor.digest).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
  expect(successor.predecessor.oracleDigest).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
  expect(successor.predecessor.fixtureRevision).toBe("ags-classification-seq7-oracle-v1");
  expect(successor.predecessor.oracleRevision).toBe("pre-live-source-reviewed-v1");
  expect(current.fixtureRevision).toBe(successor.successor.fixtureRevision);
  expect(current.oracleRevision).toBe(successor.successor.oracleRevision);
  expect(current.fixtureRevision).toBe("ags-classification-seq7-oracle-v1-source-binding-r02");
  expect(current.oracleRevision).toBe("pre-live-source-reviewed-v1-source-binding-r02");
  expect(successor.semanticProjection.digest).toBe(originalSemanticDigest);
  expect(hash(JSON.stringify(semantics(current)))).toBe(originalSemanticDigest);
  expect(current.cases).toHaveLength(39);
  expect(current.cases.filter((row: {oracle: unknown}) => row.oracle !== null)).toHaveLength(18);
  expect(successor.review.publicSyntheticCases).toBe(21);
  expect(current.status).toBe("NOT_RUN");
  expect(oracleDigest(current)).toBe(current.oracleDigest);
  expect(current.oracleDigest).toBe(successor.successor.oracleDigest);
});

it("rebinds exactly the two changed current sources across global and per-case evidence", () => {
  expect(successor.bindings.map((row: {skillId: string}) => row.skillId)).toEqual(["orchestrator", "ponytail"]);
  expect(successor.semanticProjection.omittedRevisionFields).toEqual(["fixtureRevision", "oracleRevision", "oracleDigest"]);
  let references = 0;
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const binding = successor.bindings.find((item: {skillId: string; path: string}) => item.skillId === row.skillId && item.path === row.path);
    if (binding && "digest" in row) {expect(row.digest).toBe(binding.digest); references++;}
    for (const child of Object.values(row)) walk(child);
  };
  walk(current);
  expect(references).toBe(34);
  expect(references).toBe(successor.reboundReferences);
  for (const binding of successor.bindings) {
    expect(hash(readFileSync(path.join(root, binding.path)))).toBe(binding.digest);
    expect(binding.previousDigest).toBe(binding.skillId === "orchestrator"
      ? "sha256:96125291e406b124a6559a269842d434112b98bdf28c49c752ef67dea38700b8"
      : "sha256:f9531bdd7ec9f9a46cdd09e3cc4cbe34b9dce80330bd71cc99f52cbee2a910cd");
    expect(binding.digest).not.toBe(binding.previousDigest);
  }
});
