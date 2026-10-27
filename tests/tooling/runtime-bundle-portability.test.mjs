import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { ROOT } from "../../scripts/lib.mjs";

it("generates identical executable bytes from cloned sources and distinct physical dependency junctions", async () => {
  const directory = await mkdtemp(path.join(ROOT, ".runtime-portability-"));
  const links = [];
  try {
    const outputs = [], physicalRoots = [];
    for (const id of ["a", "b"]) {
      const root = path.join(directory, `source-${id}`);
      const dependencies = path.join(directory, `physical-${id}`, "node_modules");
      const dependency = path.join(dependencies, "owned-commonjs");
      await mkdir(dependency, { recursive: true });
      await mkdir(root);
      await writeFile(path.join(dependency, "package.json"), JSON.stringify({name: "owned-commonjs", main: "index.cjs"}), "utf8");
      await writeFile(path.join(dependency, "index.cjs"), 'module.exports = { value: "owned fixture" };\n', "utf8");
      if (id === "a") await writeFile(path.join(root, "entry.mjs"), 'import value from "owned-commonjs"; console.log(JSON.stringify(value));\n', "utf8");
      else await cp(path.join(directory, "source-a", "entry.mjs"), path.join(root, "entry.mjs"));
      const link = path.join(root, "node_modules");
      await symlink(dependencies, link, "junction"); links.push(link);
      physicalRoots.push(await realpath(link));
      const script = `import {buildRuntimeBundle} from ${JSON.stringify(pathToFileURL(path.join(ROOT, "scripts", "runtime-bundles.mjs")).href)}; await buildRuntimeBundle({id:"owned-fixture",entry:"entry.mjs",output:"bundle.mjs",executable:true});`;
      execFileSync(process.execPath, ["--input-type=module", "--eval", script], {cwd: root, env: {...process.env, AGENT_GOVERNANCE_ROOT: root}, stdio: "pipe"});
      const output = path.join(root, "bundle.mjs");
      expect(execFileSync(process.execPath, [output], {encoding: "utf8"})).toBe('{"value":"owned fixture"}\n');
      outputs.push(await readFile(output));
    }
    expect(physicalRoots[0]).not.toBe(physicalRoots[1]);
    expect(outputs[0].equals(outputs[1])).toBe(true);
    for (const output of outputs) expect(output.toString()).not.toMatch(/physical-[ab]/u);
  } finally {
    // Unlink junctions before removing the owned fixture, never their targets.
    for (const link of links.reverse()) await unlink(link);
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(ROOT));
    await rm(directory, { recursive: true, force: true });
  }
});
