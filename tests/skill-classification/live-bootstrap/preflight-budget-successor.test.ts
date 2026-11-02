import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {expect, it} from "vitest";

const repo = path.resolve(import.meta.dirname, "../../..");
const directory = import.meta.dirname;
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

it("accepts the exact source successor and rejects registry and repinned historical-wire bypasses", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "ags-preflight-budget-successor-"));
  try {
    const helper = path.join(scratch, "prepared-fixture.mts");
    await cp(path.join(directory, "prepared-fixture.mts"), helper);
    for (const name of await readdir(directory)) if (name.endsWith(".json")) await cp(path.join(directory, name), path.join(scratch, name));
    const input = path.join(scratch, "input");
    for (const relative of ["skills/registry.json", "skills/mutation-risk-preflight/SKILL.md", "skills/mutation-risk-preflight/classification.json", "tests/skill-classification/fixtures.json"]) {
      const target = path.join(input, relative);
      await mkdir(path.dirname(target), {recursive: true});
      await cp(path.join(repo, relative), target);
    }
    const invoke = () => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const {loadCurrentBudgetFixture}=await import(${JSON.stringify(pathToFileURL(helper).href)}); const result=await loadCurrentBudgetFixture(${JSON.stringify(input)}); console.log(result.oracle.rows.length);`],
    {cwd: repo, encoding: "utf8", timeout: 15_000});
    const baseline = invoke();
    expect(baseline.status, baseline.stderr).toBe(0);
    expect(baseline.stdout.trim()).toBe("21");

    const registryPath = path.join(input, "skills/registry.json"), registryBytes = await readFile(registryPath);
    const registry = JSON.parse(registryBytes.toString("utf8"));
    registry.skills.find((entry: {skillId: string}) => entry.skillId === "mutation-risk-preflight").version = "1.0.3";
    await writeFile(registryPath, JSON.stringify(registry, null, 2) + "\n");
    expect(invoke().status).toBe(1);
    await writeFile(registryPath, registryBytes);

    const successorPath = path.join(scratch, "budget-wire-preflight-private-successor.json");
    const successorBytes = await readFile(successorPath), successor = JSON.parse(successorBytes.toString("utf8"));
    const previous = JSON.parse(await readFile(path.join(scratch, "budget-wire-d0336-source-binding-successor.json"), "utf8"));
    successor.rows[0].wireDigest = previous.rows[0].wireDigest;
    const changed = JSON.stringify(successor, null, 2) + "\n";
    await writeFile(successorPath, changed);
    expect(invoke().status).toBe(1);
    // Even bypassing the outer manifest pin must not accept the historical wire.
    await writeFile(helper, (await readFile(helper, "utf8")).replace(hash(successorBytes), hash(changed)));
    const bypass = invoke();
    expect(bypass.status).toBe(1);
    expect(bypass.stderr).toContain("PREFLIGHT_CURRENT_WIRE_BINDING_REQUIRED");
    expect(hash(await readFile(path.join(repo, "tests/skill-classification/fixtures.json")))).toBe(successor.fixtureDigest);
    expect(execFileSync("git", ["diff", "--", "tests/skill-classification/fixtures.json"], {cwd: repo, encoding: "utf8"})).toBe("");
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}, 30_000);
