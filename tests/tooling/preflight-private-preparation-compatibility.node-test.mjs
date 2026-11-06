import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  beforeSpecialistBehaviorSuccessor,
  checkRegistryContextCompatibility,
  checkSpecialistBehaviorSources,
  matchesPreflightAdditiveSourceSuccessor,
  matchesPreflightExpiryRemovalSuccessor,
  matchesPreflightPrivatePreparationSuccessor,
  matchesPreflightPlatformEventsSuccessor,
  pinnedDigest,
  readHistoricalSource,
} from "../../scripts/check-skill-context-optimization.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "59a580ac950e4813108d5b3a83bf01b9de0d7ccb";
const privatePreparationRevision = "245a1e85ab649acb4a6766ad2332191edb35cb74";
const platformEventsRevision = "7326e5f6d74112c9935bc5d270ad46aa28476ad9";
const preBehaviorRevision = "480b8dfc143d15c7fb9fdab349d698d75f009893";
const paths = [
  "README.md", "SKILL.md", "classification.json",
  "contracts/mutation-intent.v1.schema.json", "contracts/mutation-preflight-report.v1.schema.json",
  "integration/skill-descriptor.json", "references/entry-details.md",
  "references/recovery-requirements.md",
].map((path) => `skills/mutation-risk-preflight/${path}`);

test("exact expiry-removal, platform-events and private-preparation successors preserve the historical chain", () => {
  for (const path of paths) {
    // Pin this historical chain's endpoint; current specialist guidance is checked separately below.
    const current = execFileSync("git", ["show", `${preBehaviorRevision}:${path}`], { cwd: root });
    const platformEvents = execFileSync("git", ["show", `${platformEventsRevision}:${path}`], { cwd: root });
    const privatePreparation = execFileSync("git", ["show", `${privatePreparationRevision}:${path}`], { cwd: root });
    const historical = execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root });
    const expiryChanged = !current.equals(platformEvents);
    const changed = !platformEvents.equals(privatePreparation);
    assert.equal(matchesPreflightExpiryRemovalSuccessor(path, current), expiryChanged, path);
    assert.equal(matchesPreflightExpiryRemovalSuccessor(path, platformEvents), false, path);
    assert.equal(matchesPreflightExpiryRemovalSuccessor(path, historical), false, path);
    assert.equal(matchesPreflightExpiryRemovalSuccessor(path, Buffer.concat([current, Buffer.from("\n")])), false, path);
    if (!expiryChanged) {
      assert.equal(matchesPreflightPrivatePreparationSuccessor(path, current), !changed, path);
      assert.equal(matchesPreflightPlatformEventsSuccessor(path, current), changed, path);
    }
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, privatePreparation), true, path);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, platformEvents), !changed, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, platformEvents), changed, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, privatePreparation), false, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, historical), false, path);
    assert.equal(matchesPreflightPlatformEventsSuccessor(path, Buffer.concat([platformEvents, Buffer.from("\n")])), false, path);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, historical), false, path);
    assert.equal(matchesPreflightPrivatePreparationSuccessor(path, Buffer.concat([platformEvents, Buffer.from("\n")])), false, path);
    // These three files already had a reviewed policy-wording projection.
    const historicalRevision = ["SKILL.md", "classification.json", "references/entry-details.md"].some((suffix) => path === `skills/mutation-risk-preflight/${suffix}`)
      ? "c53ad5947bc5cc6a4e076eb9931e454e300d5c3b" : baseline;
    assert.deepEqual(readHistoricalSource(path), execFileSync("git", ["show", `${historicalRevision}:${path}`], { cwd: root }), path);
  }
  assert.equal(matchesPreflightPrivatePreparationSuccessor("skills/unreviewed/SKILL.md", Buffer.from("anything")), false);
  assert.equal(matchesPreflightPlatformEventsSuccessor("skills/unreviewed/SKILL.md", Buffer.from("anything")), false);
  assert.equal(matchesPreflightExpiryRemovalSuccessor("skills/unreviewed/SKILL.md", Buffer.from("anything")), false);
});

test("current specialist guidance preserves exact preflight predecessors and rejects altered bytes", () => {
  const report = checkSpecialistBehaviorSources();
  assert.deepEqual(report.errors, []);
  assert.equal(report.pass, true);
  for (const path of paths) {
    const current = readFileSync(new URL(`../../${path}`, import.meta.url));
    const predecessor = execFileSync("git", ["show", `${preBehaviorRevision}:${path}`], { cwd: root });
    const altered = Buffer.concat([current, Buffer.from("\n")]);
    // Only context and contract bytes belong to this historical projection.
    assert.equal(pinnedDigest(path, beforeSpecialistBehaviorSuccessor(path, current)),
      createHash("sha256").update(predecessor).digest("hex"), path);
    assert.deepEqual(beforeSpecialistBehaviorSuccessor(path, altered), altered, path);
    for (const matcher of [
      matchesPreflightExpiryRemovalSuccessor,
      matchesPreflightPlatformEventsSuccessor,
      matchesPreflightPrivatePreparationSuccessor,
    ]) {
      assert.equal(matcher(path, current), matcher(path, predecessor), path);
      assert.equal(matcher(path, altered), false, path);
    }
  }
});

test("executable changes have no context successor projection (D0026)", () => {
  const path = "skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
  const current = readFileSync(new URL(`../../${path}`, import.meta.url));
  const predecessor = execFileSync("git", ["show", `${preBehaviorRevision}:${path}`], { cwd: root });
  for (const bytes of [current, predecessor, Buffer.concat([current, Buffer.from("\n// runtime-only change\n")])]) {
    assert.equal(pinnedDigest(path, bytes), createHash("sha256").update(bytes).digest("hex"));
    for (const matcher of [matchesPreflightExpiryRemovalSuccessor, matchesPreflightPlatformEventsSuccessor, matchesPreflightPrivatePreparationSuccessor]) {
      assert.equal(matcher(path, bytes), false);
    }
  }
  // The public checker plus source-lock mutation is exercised in skill-context-optimization.test.mjs.
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
