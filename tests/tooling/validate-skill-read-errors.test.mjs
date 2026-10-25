import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function suiteRoot() {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-read-errors-"));
  directories.push(directory);
  return directory;
}
// ROOT is captured at import time, so each probe runs in a fresh process.
function probe(root, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, AGENT_GOVERNANCE_ROOT: root },
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
const validateSkillProbe = (name) =>
  `import { validateSkill } from ${JSON.stringify(pathToFileURL(path.join(repository, "scripts", "validate-skill.mjs")).href)};
   console.log(JSON.stringify(await validateSkill(${JSON.stringify(name)})));`;

it("validate-skill은 ENOENT만 SKILL.md 누락으로 보고하고 다른 읽기 실패는 code로 구분한다", async () => {
  const root = await suiteRoot();
  await mkdir(path.join(root, "skills", "unreadable", "SKILL.md"), { recursive: true });
  expect(probe(root, validateSkillProbe("absent"))).toEqual(["Missing skills/absent/SKILL.md"]);
  expect(probe(root, validateSkillProbe("unreadable"))).toEqual(["cannot read skills/unreadable/SKILL.md: EISDIR"]);
});

it("validate-skill은 상대 링크의 ENOENT·URI 오류·접근 실패를 서로 다르게 보고한다", async () => {
  const root = await suiteRoot();
  const skill = path.join(root, "skills", "linked");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(root, "skills", "registry.json"), JSON.stringify({ skills: [{ skillId: "linked" }] }));
  await writeFile(
    path.join(skill, "SKILL.md"),
    "---\nname: linked\ndescription: fixture skill for link diagnostics only\n---\n[a](gone.md) [b](%E0%A4%A.md) [c](loop-a)\n",
  );
  // Native symlink-cycle codes differ by OS; fault only this access boundary.
  const errors = probe(root, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const access = fs.access;
    fs.access = async (target, ...args) => {
      if (target === ${JSON.stringify(path.join(skill, "loop-a"))}) {
        throw Object.assign(new Error("fixture link access failure"), { code: "ELOOP" });
      }
      return access(target, ...args);
    };
    syncBuiltinESMExports();
    ${validateSkillProbe("linked")}
  `);
  expect(errors).toContain("broken relative link: gone.md");
  expect(errors).toContain("invalid link URI: %E0%A4%A.md (URIError)");
  expect(errors).toContain("cannot access link target: loop-a (ELOOP)");
  expect(errors.filter((error) => error.startsWith("broken relative link"))).toHaveLength(1);
});

it("readSkillVersion은 VERSION이 없을 때만 neither 오류를 내고 읽기 실패의 code를 보존한다", async () => {
  const root = await suiteRoot();
  for (const name of ["absent", "unreadable"]) {
    await mkdir(path.join(root, "skills", name), { recursive: true });
    await writeFile(path.join(root, "skills", name, "SKILL.md"), "---\nname: x\n---\n");
  }
  await mkdir(path.join(root, "skills", "unreadable", "VERSION"));
  const source = path.join(repository, "scripts", "source-lock.mjs");
  const messages = probe(
    root,
    `import { readFile } from "node:fs/promises";
     import { readSkillVersion } from ${JSON.stringify(pathToFileURL(source).href)};
     const describe = (error) => ({ message: error.message, code: error.code,
       causeCode: error.cause?.code, path: error.path, syscall: error.syscall });
     const out = {};
     try { await readFile(${JSON.stringify(path.join(root, "skills", "unreadable", "VERSION"))}, "utf8"); }
     catch (error) { out.native = describe(error); }
     for (const name of ["absent", "unreadable"]) {
       try { await readSkillVersion(${JSON.stringify(path.join(root, "skills"))} + "/" + name); }
       catch (error) { out[name] = describe(error); }
     }
     console.log(JSON.stringify(out));`,
  );
  expect(messages.absent.message).toContain("has neither metadata.version nor VERSION");
  expect(messages.absent.causeCode).toBe("ENOENT");
  expect(messages.unreadable.code).toBe("EISDIR");
  expect(messages.unreadable).toEqual(messages.native);
  expect(messages.unreadable.message).not.toContain("has neither metadata.version nor VERSION");
});

it("mutation-risk-preflight validator는 JSON 문법 오류와 읽기 실패를 구분한다", async () => {
  const root = await suiteRoot();
  await mkdir(path.join(root, "scripts"));
  await mkdir(path.join(root, "contracts", "upstream"), { recursive: true });
  await mkdir(path.join(root, "integration"));
  await copyFile(
    path.join(repository, "skills", "mutation-risk-preflight", "scripts", "validate-skill.mjs"),
    path.join(root, "scripts", "validate-skill.mjs"),
  );
  await writeFile(path.join(root, "SKILL.md"), "---\nname: mutation-risk-preflight\n---\n");
  await writeFile(path.join(root, "contracts", "upstream", "lock.json"), JSON.stringify({ upstreams: [{ snapshotPath: "SKILL.md", sha256: "0" }] }));
  await writeFile(path.join(root, "contracts", "syntax.json"), "{");
  await mkdir(path.join(root, "contracts", "unreadable.json"));
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "validate-skill.mjs")], { encoding: "utf8" });
  const { errors } = JSON.parse(result.stdout);
  expect(result.status).toBe(1);
  expect(errors).toContain("invalid JSON contracts/syntax.json");
  expect(errors).toContain("cannot read contracts/unreadable.json: EISDIR");
  expect(errors).not.toContain("invalid JSON contracts/unreadable.json");
  expect(errors).toContain("missing agents/openai.yaml");
});
