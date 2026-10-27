import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { build } from "esbuild";
import { ROOT } from "../../scripts/lib.mjs";
import { buildThirdPartyNotices } from "../../scripts/runtime-bundles.mjs";

// Owned fixtures only; esbuild runs without output files or dependency installation.
const directories = [], links = [];
afterEach(async () => {
  // Remove every owned link first; if unlink fails, do not recursively remove its parent.
  while (links.length > 0) {
    await unlink(links[links.length - 1]);
    links.pop();
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  // A sibling guarantees ROOT and the physical input use the same volume on Windows.
  const directory = await mkdtemp(path.join(path.dirname(ROOT), "ags-notices-owned-"));
  directories.push(directory);
  expect(path.dirname(directory)).toBe(path.dirname(ROOT));
  return directory;
}

async function ownedPackage(root, name = "owned-notice-package", metadata = true) {
  const directory = path.join(root, "node_modules", name), entry = path.join(directory, "lib", "entry.js");
  await mkdir(path.dirname(entry), { recursive: true });
  if (metadata) await writeFile(path.join(directory, "package.json"), JSON.stringify({ name, version: "1.2.3", license: "MIT" }), "utf8");
  await writeFile(path.join(directory, "LICENSE"), "Owned fixture license text.\n", "utf8");
  await writeFile(entry, "export const fixture = true;\n", "utf8");
  return { directory, entry };
}

it("collects the same owned license from actual ../ physical and absolute metafile inputs outside ROOT", async () => {
  const directory = await fixture(), { entry } = await ownedPackage(directory);
  const relative = path.relative(ROOT, entry).split(path.sep).join("/");
  expect(path.isAbsolute(relative)).toBe(false); expect(relative.startsWith("../")).toBe(true); expect(path.isAbsolute(entry)).toBe(true);
  const relativeNotice = await buildThirdPartyNotices({ inputs: { [relative]: {} } });
  const absoluteNotice = await buildThirdPartyNotices({ inputs: { [entry]: {} } });
  expect(relativeNotice).toContain("## owned-notice-package 1.2.3 (MIT)"); expect(relativeNotice).toContain("Owned fixture license text.");
  expect(absoluteNotice).toBe(relativeNotice);
  expect(await buildThirdPartyNotices({ inputs: { [relative]: {}, [entry]: {} } })).toBe(relativeNotice);
});

it("accepts flat node_modules inputs and ignores own project files even beneath a node_modules ancestor", async () => {
  const directory = await fixture(), root = path.join(directory, "node_modules", "owned-project");
  await ownedPackage(root, "owned-flat-package");
  const notice = await buildThirdPartyNotices({ inputs: { "node_modules/owned-flat-package/lib/entry.js": {}, "src/project.js": {} } }, root);
  expect(notice).toContain("## owned-flat-package 1.2.3 (MIT)"); expect(notice.match(/^## /gmu)).toHaveLength(1);
  expect(await buildThirdPartyNotices({ inputs: { "src/project.js": {} } }, root)).not.toContain("## ");
  const sibling = await ownedPackage(directory, "owned-sibling-package");
  const siblingInput = path.relative(root, sibling.entry).split(path.sep).join("/");
  expect(siblingInput.startsWith("../")).toBe(true); expect(siblingInput).not.toContain("node_modules/");
  expect(await buildThirdPartyNotices({ inputs: { [siblingInput]: {} } }, root)).toContain("## owned-sibling-package 1.2.3 (MIT)");
  const shared = path.join(directory, "shared", "entry.js");
  await mkdir(path.dirname(shared), { recursive: true }); await writeFile(shared, "export const shared = true;\n", "utf8");
  expect(await buildThirdPartyNotices({ inputs: { [shared]: {} } }, root)).not.toContain("## ");
});

it("rejects dependency metadata absence and preserves metadata or license I/O failures", async () => {
  const root = await fixture();
  const missing = await ownedPackage(root, "owned-missing", false);
  await expect(buildThirdPartyNotices({ inputs: { [missing.entry]: {} } }, root)).rejects.toMatchObject({
    message: expect.stringContaining("No package metadata for bundled dependency"), cause: { code: "ENOENT" },
  });
  const invalid = await ownedPackage(root, "owned-unreadable", false);
  await mkdir(path.join(invalid.directory, "package.json"));
  await expect(buildThirdPartyNotices({ inputs: { [invalid.entry]: {} } }, root)).rejects.toMatchObject({
    message: expect.stringContaining("Cannot read bundled package metadata"), cause: { code: "EISDIR" },
  });
  const badLicense = await ownedPackage(root, "owned-license-io");
  await rm(path.join(badLicense.directory, "LICENSE")); await mkdir(path.join(badLicense.directory, "LICENSE"));
  await expect(buildThirdPartyNotices({ inputs: { [badLicense.entry]: {} } }, root)).rejects.toMatchObject({
    message: expect.stringContaining("Cannot read bundled package license"), cause: { code: "EISDIR" },
  });
});

// Exercise the metafile supplied by esbuild, using only owned fixture packages.
it("includes the license for an external node_modules package reached through a junction", async () => {
  const directory = await fixture(), root = path.join(directory, "project");
  const dependency = await ownedPackage(directory, "owned-junction-package");
  await writeFile(path.join(dependency.directory, "package.json"), JSON.stringify({ name: "owned-junction-package", version: "1.2.3", license: "MIT", main: "lib/entry.js" }), "utf8");
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  const link = path.join(root, "node_modules", "owned-junction-package");
  await symlink(dependency.directory, link, "junction"); links.push(link);
  await writeFile(path.join(root, "entry.js"), 'import { fixture } from "owned-junction-package"; console.log(fixture);\n', "utf8");
  const result = await build({ absWorkingDir: root, entryPoints: ["entry.js"], bundle: true, write: false, metafile: true, platform: "node", format: "esm" });
  const physicalInput = path.relative(root, dependency.entry).split(path.sep).join("/");
  expect(physicalInput.startsWith("../")).toBe(true);
  expect(Object.keys(result.metafile.inputs)).toContain(physicalInput);
  const notice = await buildThirdPartyNotices(result.metafile, root);
  expect(notice).toContain("## owned-junction-package 1.2.3 (MIT)");
  expect(notice).toContain("Owned fixture license text.");
});

it("does not treat an external shared file reached through a relative symlink as a dependency", async (context) => {
  const directory = await fixture(), root = path.join(directory, "project"), shared = path.join(directory, "shared");
  await mkdir(root); await mkdir(shared);
  await writeFile(path.join(shared, "package.json"), JSON.stringify({ name: "owned-shared", version: "1.2.3", license: "MIT" }), "utf8");
  await writeFile(path.join(shared, "LICENSE"), "Shared source is not a dependency.\n", "utf8");
  await writeFile(path.join(shared, "entry.js"), "export const shared = true;\n", "utf8");
  const link = path.join(root, "linked-shared");
  try { await symlink(path.relative(root, shared), link, "dir"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error?.code)) { context.skip(); return; } throw error; }
  links.push(link);
  await writeFile(path.join(root, "entry.js"), 'import { shared } from "./linked-shared/entry.js"; console.log(shared);\n', "utf8");
  const result = await build({ absWorkingDir: root, entryPoints: ["entry.js"], bundle: true, write: false, metafile: true, platform: "node", format: "esm" });
  const physicalInput = path.relative(root, path.join(shared, "entry.js")).split(path.sep).join("/");
  expect(physicalInput.startsWith("../")).toBe(true);
  expect(Object.keys(result.metafile.inputs)).toContain(physicalInput);
  const notice = await buildThirdPartyNotices(result.metafile, root);
  expect(notice).not.toContain("## owned-shared");
});

it("uses the package root license when a nested export directory has its own package.json", async () => {
  const root = await fixture(), dependency = await ownedPackage(root, "owned-nested-export");
  await writeFile(path.join(dependency.directory, "lib", "package.json"), JSON.stringify({type: "module"}), "utf8");
  const notice = await buildThirdPartyNotices({inputs: {[dependency.entry]: {}}}, root);
  expect(notice).toContain("## owned-nested-export 1.2.3 (MIT)");
  expect(notice).toContain("Owned fixture license text.");
});
