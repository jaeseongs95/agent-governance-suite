import assert from "node:assert/strict";
import {cp, mkdir, readFile, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
const repo = path.resolve(process.argv[2] ?? ".");
const directory = path.join(repo, "tests/skill-classification/live-bootstrap");
const cases = [
  ["producer-version", "mcp-server/src/skill-classification/inventory.ts", "version: entry?.version ?? head.version!", "version: (entry?.version ?? head.version!) + '-mutated'", "INDEPENDENT_INVENTORY_DIGEST"],
  ["producer-prompt", "tests/skill-classification/live-bootstrap/bootstrap.mts", "originalPrompt: row.originalPrompt, inventory", "originalPrompt: row.originalPrompt + ' mutated', inventory", "INDEPENDENT_REQUEST_DIGEST"],
  ["producer-order", "mcp-server/src/skill-classification/inventory.ts", "const skills = candidates.filter((skill) => !duplicates.has(skill.skillId));", "const skills = candidates.filter((skill) => !duplicates.has(skill.skillId)).reverse();", "INDEPENDENT_INVENTORY_DIGEST"],
  ["wire-prompt", "mcp-server/src/skill-classification/providers.ts", "Does the actual user objective/actions require this skill?", "Does this altered objective require this skill?", "INDEPENDENT_WIRE_DIGEST"],
  ["final-fetch-body", "tests/skill-classification/live-bootstrap/bootstrap.mts", "const response = await fetcher(...args);", "const response = await fetcher(args[0], {...args[1], body: String(args[1]?.body).replace('\"model\":\"mock-model\"', '\"model\":\"tampered\"')});", "INDEPENDENT_DISPATCH_WIRE"],
  ["price", "tests/skill-classification/live-bootstrap/bootstrap.mts", "prices!.inputUsdPer1k.toString().toLowerCase()", "(prices!.inputUsdPer1k * 0.5).toString().toLowerCase()", "INDEPENDENT_RESERVATION_PRICE"],
] as const;
// Optional final positional argument selects one complete scenario; no argument retains the full CLI suite.
const scenario = process.argv[5];
assert(process.argv.length <= 6, "UNEXPECTED_MUTATION_ARGUMENTS");
assert(scenario === undefined || cases.some(([id]) => id === scenario), `UNKNOWN_MUTATION_SCENARIO:${scenario}`);
// A URL import keeps this test-only ESM helper outside TypeScript's allowJs scope.
const {createSourceScratch, prepareSourceScratch, removeSourceScratch} = await import(new URL("./source-scratch.mjs", import.meta.url).href);
const parentOwnsRoot = process.argv[4] !== undefined;
const root = parentOwnsRoot ? path.resolve(process.argv[4]!) : createSourceScratch(repo);
try {
  prepareSourceScratch(repo, root);
  const childTemp = path.join(root, "children");
  await mkdir(childTemp);
  await cp(path.join(repo, "skills"), path.join(root, "skills"), {recursive:true});
  await cp(path.join(repo, "mcp-server/src"), path.join(root, "mcp-server/src"), {recursive:true});
  await mkdir(path.join(root, "tests/skill-classification/live-bootstrap"), {recursive:true});
  for (const file of ["fixtures.json", "evaluation.ts", "fixtures.source-successor.json", "fixtures.unavailable-source-successor.json", "fixtures.live-host-boundaries-source-successor.json", "fixtures.continuity-handoff-source-successor.json"]) await cp(path.join(repo,"tests/skill-classification",file),path.join(root,"tests/skill-classification",file));
  for (const file of ["bootstrap.mts","prepared-fixture.mts","independent-wire-oracle.mts","dynamic-current-oracle.mts"]) await cp(path.join(directory,file),path.join(root,"tests/skill-classification/live-bootstrap",file));
  const checks: string[] = [];
  const runOracle = () => new Promise<{status: number | null; stderr: string}>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "tests/skill-classification/live-bootstrap/dynamic-current-oracle.mts"), root], {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      env: {...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp},
    });
    let stderr = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", chunk => {stderr += String(chunk);});
    const timer = setTimeout(() => {child.kill(); reject(new Error("ORACLE_TIMEOUT"));}, 90000);
    child.once("error", error => {clearTimeout(timer); reject(error);});
    child.once("close", status => {clearTimeout(timer); resolve({status, stderr});});
  });
  const green = async (id: string) => {
    const result = await runOracle();
    assert.equal(result.status,0,`${id}:exit=${result.status} stderr=${result.stderr}`);
    checks.push(`${id}: GREEN`);
  };
  await green("baseline");
  for (const [id, file, before, after, marker] of cases) {
    if (scenario !== undefined && id !== scenario) continue;
    const target = path.join(root,file), original = await readFile(target,"utf8"); assert.equal(original.split(before).length,2,`MUTATION_ANCHOR:${id}`);
    await writeFile(target,original.replace(before,after),"utf8");
    try {
      const result = await runOracle();
      assert.equal(result.status,1,`${id}:exit=${result.status} stderr=${result.stderr}`);
      assert(result.stderr.includes(marker),`${id}:expected ${marker}: ${result.stderr}`);
      checks.push(`${id}: RED ${marker}`);
    } finally { await writeFile(target,original,"utf8"); }
    await green(`${id}:restored`);
  }
  console.log(JSON.stringify({status:"INDEPENDENT_MUTATIONS_PASS",checks,actualApiCalls:0,actualCredentialLookups:0}));
} finally {if (!parentOwnsRoot) removeSourceScratch(root);}
