import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {loadCurrentSourceBindings} from "./evaluation.js";

const root = new URL("../../", import.meta.url);
const rootDirectory = fileURLToPath(root);
const read = (file: string) => readFileSync(new URL(file, root));
const hash = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

it("binds parent accountability after frozen r27 without changing prior source-span meaning (AGS3-T-0020 PA05)", async () => {
  // No child process: CI's process-boundary split includes this current-source binding regression.
  const predecessor = read("tests/skill-classification/fixtures.intake-verify-and-ask-source-successor.json");
  expect(hash(predecessor)).toBe("sha256:4b6aa9f9ec8a7de6529a3870a9d7825f256f9577438cdd097ab27454e6786416");
  const previous = JSON.parse(predecessor.toString("utf8"));
  const bytes = read("tests/skill-classification/fixtures.parent-accountability-source-successor.json");
  expect(hash(bytes)).toBe("sha256:a33cbf59c8289e85119ebc6898374a88d6f019fd37549321fb7362e19ed6abc2");
  const manifest = JSON.parse(bytes.toString("utf8"));
  expect(manifest).toMatchObject({revision: "parent-accountability-source-binding-r28",
    sourceBaseRevision: "2133f629fa74400a961465178905be8d001a52f2", fixtureFileRewritten: false,
    labelChanges: [], priceAndBudgetChanges: [], modelBehavior: "NOT_RUN"});
  expect(manifest.frozenPredecessor).toEqual({path: "tests/skill-classification/fixtures.intake-verify-and-ask-source-successor.json",
    bytes: predecessor.length, digest: hash(predecessor)});
  const domain = JSON.parse(read("tests/skill-classification/fixtures.intake-domain-neutral-source-successor.json").toString("utf8"));
  const nativeProcedure = JSON.parse(read("tests/skill-classification/fixtures.native-procedure-source-successor.json").toString("utf8"));
  const testEngineeringCli = JSON.parse(read("tests/skill-classification/fixtures.test-engineering-cli-source-successor.json").toString("utf8"));
  const current = loadCurrentSourceBindings(rootDirectory);
  expect(current.manifest).toMatchObject({revision: testEngineeringCli.revision});
  expect(manifest.bindings.map((binding: {path: string}) => binding.path)).toEqual(previous.bindings.map((binding: {path: string}) => binding.path));
  for (const binding of manifest.bindings) {
    expect(binding.previousDigest).toBe(previous.bindings.find((row: {path: string}) => row.path === binding.path).digest);
    const domainLatest = domain.bindings.find((row: {path: string}) => row.path === binding.path);
    expect(domainLatest.previousDigest).toBe(binding.digest);
    const successor = nativeProcedure.bindings.find((row: {path: string}) => row.path === binding.path);
    if (successor) expect(successor.previousDigest).toBe(domainLatest.digest);
    const latest = successor ?? domainLatest;
    const actual = read(binding.path);
    expect([actual.length, hash(actual)]).toEqual([latest.bytes, latest.digest]);
    expect(current.resolveDigest(binding.path, binding.previousDigest)).toBe(latest.digest);
  }
  const descriptor = JSON.parse(read("skills/orchestrator/classification.json").toString("utf8"));
  const inventory = await loadSkillInventory({root: rootDirectory});
  expect(inventory.issues).toEqual([]);
  const orchestrator = inventory.skills.find(skill => skill.skillId === "orchestrator")!;
  expect(manifest.spanPreservation.spans).toHaveLength(18);
  const changed: string[] = [];
  for (const span of manifest.spanPreservation.spans) {
    const prior = previous.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === span.group && row.index === span.index);
    const reference = descriptor[span.group][span.index];
    const source = read(reference.path);
    expect(hash(source)).toBe(reference.digest);
    const selected = Buffer.from(source.toString("utf8").split(/\r?\n/u).slice(reference.startLine - 1, reference.endLine).join("\n"))
      .subarray(reference.startByte ?? 0, reference.endByte);
    const live = nativeProcedure.spanPreservation.spans.find((row: {skillId: string; group: string; index: number}) => row.skillId === "orchestrator" && row.group === span.group && row.index === span.index)
      ?? domain.spanPreservation.spans.find((row: {group: string; index: number}) => row.group === span.group && row.index === span.index);
    expect([selected.length, hash(selected)]).toEqual([live.bytes, live.digest]);
    expect(orchestrator[span.group as "applicability" | "exclusions"]).toContain(selected.toString("utf8").trim());
    expect([span.path, span.startLine, span.endLine, span.startByte]).toEqual([prior.path, prior.startLine, prior.endLine, prior.startByte]);
    if (span.digest !== prior.digest) changed.push(`orchestrator:${span.group}[${span.index}]`);
    else expect(span).toEqual(prior);
  }
  expect(changed).toEqual(["orchestrator:applicability[5]"]);
  expect(manifest.spanPreservation.changedSpans).toEqual(changed);
});
