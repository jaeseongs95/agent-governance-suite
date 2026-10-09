import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {readClassificationRuntime} from "../../mcp-server/src/skill-classification/gateway.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

async function configuration(timeoutMs: unknown, withProfiles = true) {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-classification-timeout-config-"));
  directories.push(directory);
  if (withProfiles) await writeFile(path.join(directory, "profiles.json"), JSON.stringify({schemaVersion: "1.0.0", profileRevision: "synthetic-empty", profiles: []}));
  const config = {jevEnabled: false, mode: "select", providerProfileRegistryRef: "profiles.json", externalClassificationAllowed: false, configRevision: "synthetic-config", timeoutMs};
  const file = path.join(directory, "config.json");
  await writeFile(file, JSON.stringify({config, allowRemotePrivateContent: false}));
  return {directory, file, config};
}

describe("classification timeout at the actual file configuration boundary", () => {
  // Node timers accept at most 2^31 - 1 ms; larger values are silently reduced to 1 ms.
  // Loader-only checks need no timer wait, transport mock, model qualification, or paid provider.
  it.each([1, 40, 30_000, 2_147_483_646, 2_147_483_647])("r16-timer: preserves supported timeout %i exactly", async timeoutMs => {
    const fixture = await configuration(timeoutMs);
    const runtime = await readClassificationRuntime(fixture.file, fixture.directory);
    expect(runtime.config).toEqual(fixture.config);
    expect(runtime.registry.profiles).toEqual([]);
  });

  it.each([
    ["zero", 0], ["negative", -1], ["fractional", 1.5],
    ["one above Node maximum", 2_147_483_648], ["safe integer beyond Node maximum", Number.MAX_SAFE_INTEGER],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["numeric string", "30000"],
    ["null", null], ["boolean", true], ["object", {}], ["array", [30000]],
    ["omitted", undefined], ["NaN serialized as null", NaN], ["Infinity serialized as null", Infinity],
  ])("r16-timer: rejects %s timeout before loading provider profiles", async (_label, timeoutMs) => {
    // There is deliberately no profile file: rejection must come from config validation, not ENOENT.
    const fixture = await configuration(timeoutMs, false);
    await expect(readClassificationRuntime(fixture.file, fixture.directory)).rejects.toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({path: ["config", "timeoutMs"]})]),
    });
  });

  it("r16-timer: keeps the unconfigured 30-second default and unavailable provider inventory", async () => {
    const runtime = await readClassificationRuntime(undefined, "/unused-synthetic-root");
    expect(runtime.config.timeoutMs).toBe(30_000);
    expect(runtime.config.externalClassificationAllowed).toBe(false);
    expect(runtime.registry.profiles).toEqual([]);
  });
});

import {SkillClassificationService, InMemoryClassificationBudget} from "../../mcp-server/src/skill-classification/service.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";

it.each([2147483648, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, 0, -1, 1.5])("r16-timer: direct service rejects unsupported %s before provider/timer dispatch", async timeoutMs => {
  const request = createClassificationRequest({requestId: "timeout", operationId: "timeout", originalPrompt: "review", inventory: {skills: [], issues: [], inventoryDigest: "sha256:" + "a".repeat(64), taxonomyRevision: "synthetic"}, classificationCriteriaRef: "synthetic"});
  const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {}})});
  const result = await service.classify({request, config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "synthetic", externalClassificationAllowed: false, configRevision: "c1", timeoutMs}, registry: {schemaVersion: "1.0.0", profileRevision: "p1", profiles: []}, currentVendorId: "synthetic"});
  expect(result.response.error?.code).toBe("INVALID_TIMEOUT"); expect(result.attempts).toEqual([]);
});
