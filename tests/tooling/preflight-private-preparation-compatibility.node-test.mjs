import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  checkRegistryContextCompatibility,
  matchesPreflightAdditiveSourceSuccessor,
  matchesPreflightPrivatePreparationSuccessor,
  matchesPreflightPlatformEventsSuccessor,
  readHistoricalSource,
} from "../../scripts/check-skill-context-optimization.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "59a580ac950e4813108d5b3a83bf01b9de0d7ccb";
const privatePreparationRevision = "245a1e85ab649acb4a6766ad2332191edb35cb74";
const paths = [
  "README.md", "SKILL.md", "classification.json",
  "contracts/mutation-intent.v1.schema.json", "contracts/mutation-preflight-report.v1.schema.json",
  "integration/skill-descriptor.json", "references/entry-details.md",
  "references/recovery-requirements.md", "scripts/evaluate-preflight.mjs",
].map((path) => `skills/mutation-risk-preflight/${path}`);

test("exact platform-events and private-preparation successors preserve the historical chain", () => {
  for (const path of paths) {
    const current = readFileSync(new URL(`../../${path}`, import.meta.url));
    const privatePreparation = execFileSync("git", ["show", `${privatePreparationRevision}:${path}`], { cwd: root });
    const historical = execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root });
    const changed = !current.equals(privatePreparation);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, privatePreparation), true, path);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, current), !changed, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, current), changed, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, privatePreparation), false, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, historical), false, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, Buffer.concat([current, Buffer.from("\n")])), false, path);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, historical), false, path);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, Buffer.concat([current, Buffer.from("\n")])), false, path);
    // These three files already had a reviewed policy-wording projection.
    const historicalRevision = ["SKILL.md", "classification.json", "references/entry-details.md"].some((suffix) => path === `skills/mutation-risk-preflight/${suffix}`)
      ? "c53ad5947bc5cc6a4e076eb9931e454e300d5c3b" : baseline;
    assert.deepEqual(readHistoricalSource(path), execFileSync("git", ["show", `${historicalRevision}:${path}`], { cwd: root }), path);
  }
  assert.equal(matchesPreflightPrivatePreparationSuccessor("skills/unreviewed/SKILL.md", Buffer.from("anything")), false);
  assert.equal(matchesPreflightPlatformEventsSuccessor("skills/unreviewed/SKILL.md", Buffer.from("anything")), false);
});

test("existing additive pins remain valid after the exact successor projection", () => {
  for (const path of ["contracts/mutation-intent.v1.schema.json", "references/recovery-requirements.md"]) {
    const relative = `skills/mutation-risk-preflight/${path}`;
    assert.equal(matchesPreflightAdditiveSourceSuccessor(relative, readHistoricalSource(relative)), true);
  }
});

test("current registry accepts only the fixed version and preserves authority fields", () => {
  const registry = JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));
  assert.deepEqual(checkRegistryContextCompatibility(registry), []);
  for (const change of ["version", "priority", "gate", "bindings"]) {
    const changed = structuredClone(registry);
    const descriptor = changed.skills.find((entry) => entry.skillId === "mutation-risk-preflight");
    if (change === "version") descriptor.version = "1.0.4";
    if (change === "priority") descriptor.priority += 1;
    if (change === "gate") descriptor.providers[0].gate.policy = "none";
    if (change === "bindings") descriptor.providers[0].inputBindings[0].sources = ["untrusted:approval"];
    assert.ok(checkRegistryContextCompatibility(changed).includes("registry differs from the 3.0 contract"), change);
  }
});
