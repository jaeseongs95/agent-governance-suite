import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { NAME_PATTERN, ROOT, defaultProvider, parseArguments, readJson } from "./lib.mjs";
import { Ajv2020 } from "../runtime/schema-validation.mjs";

const args = parseArguments(process.argv.slice(2));
const { name, phase, capability } = args;
if (!name || !phase || !capability) {
  throw new Error("Usage: pnpm new:skill --name <name> --phase <phase> --capability <capability>");
}
if (!NAME_PATTERN.test(name) || !NAME_PATTERN.test(capability)) {
  throw new Error("name and capability must use kebab-case");
}

const realRoot = await realpath(ROOT);
async function assertContained(target) {
  let existing = target;
  for (;;) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const relative = path.relative(realRoot, await realpath(existing));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path escapes the suite root: ${target}`);
  }
}

async function assertAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`destination already exists: ${target}`);
}

const registryPath = path.join(realRoot, "skills", "registry.json");
const skillDirectory = path.join(realRoot, "skills", name);
const testsDirectory = path.join(realRoot, "tests", name);
for (const target of [registryPath, skillDirectory, testsDirectory]) await assertContained(target);
const registryDocument = await readJson(registryPath);
const skills = registryDocument.skills;
if (registryDocument.schemaVersion !== "2.0.0") throw new Error("skills/registry.json must use schemaVersion 2.0.0");
if (skills.some((descriptor) => descriptor.skillId === name)) {
  throw new Error(`registry already contains ${name}`);
}
const capabilityOwner = skills.find((descriptor) => descriptor.providers?.some((provider) => provider.capabilities?.includes(capability)));
if (capabilityOwner) {
  throw new Error(`capability ${capability} is already provided by ${capabilityOwner.skillId}; choose a more specific capability`);
}

const descriptor = {
  schemaVersion: "2.0.0",
  skillId: name,
  version: "0.1.0",
  path: `./${name}`,
  priority: 50,
  enabled: true,
  providers: [defaultProvider(capability, phase)]
};
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateDescriptor = ajv.compile(await readJson(new URL("../contracts/skill-descriptor.v2.schema.json", import.meta.url)));
if (!validateDescriptor(descriptor)) {
  throw new Error(`invalid skill descriptor: ${ajv.errorsText(validateDescriptor.errors)}`);
}
await assertAbsent(skillDirectory);
await assertAbsent(testsDirectory);
await mkdir(path.dirname(testsDirectory), { recursive: true });
await mkdir(testsDirectory);
await mkdir(skillDirectory);
await mkdir(path.join(skillDirectory, "agents"));

await writeFile(path.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\ndescription: ${capability} 기능이 필요한 요청을 처리한다. 관련 기능이 필요하지 않은 일반 작업에는 사용하지 않는다.\nmetadata:\n  version: 0.1.0\n---\n\n# ${name}\n\n요청의 목표와 권한 범위 안에서 ${capability} 결과를 만든다.\n\n## 입력\n\n- 목표와 수용 기준\n- 적용할 제약과 사용 가능한 근거\n\n## 출력\n\n결과, 검증 근거, 남은 제약을 구분해 반환한다.\n`, { encoding: "utf8", flag: "wx" });
await writeFile(path.join(skillDirectory, "agents", "openai.yaml"), `interface:\n  display_name: "${name}"\n  short_description: "${capability} 작업을 수행하는 전문 스킬"\n  default_prompt: "Use $${name} to handle this ${capability} task."\npolicy:\n  allow_implicit_invocation: true\n`, { encoding: "utf8", flag: "wx" });
await writeFile(path.join(testsDirectory, "cases.json"), `${JSON.stringify({
  normal: [{ id: "normal-01", expected: "returns a result with verification evidence" }],
  boundary: [{ id: "boundary-01", expected: "preserves the caller's authorization boundary" }],
  failure: [{ id: "failure-01", expected: "reports a blocker instead of inventing missing input" }]
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

skills.push(descriptor);
await writeFile(registryPath, `${JSON.stringify(registryDocument, null, 2)}\n`, "utf8");
console.log(`created skills/${name}`);
