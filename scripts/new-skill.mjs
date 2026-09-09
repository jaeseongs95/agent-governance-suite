import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NAME_PATTERN, ROOT, parseArguments, readJson } from "./lib.mjs";

const args = parseArguments(process.argv.slice(2));
const { name, phase, capability } = args;
if (!name || !phase || !capability) {
  throw new Error("Usage: pnpm new:skill --name <name> --phase <phase> --capability <capability>");
}
if (!NAME_PATTERN.test(name) || !NAME_PATTERN.test(capability)) {
  throw new Error("name and capability must use kebab-case");
}

const registryPath = path.join(ROOT, "skills", "registry.json");
const registryDocument = await readJson(registryPath);
const skills = Array.isArray(registryDocument) ? registryDocument : registryDocument.skills;
if (registryDocument.schemaVersion !== "2.0.0") throw new Error("skills/registry.json must use schemaVersion 2.0.0");
if (skills.some((descriptor) => descriptor.skillId === name)) {
  throw new Error(`registry already contains ${name}`);
}
const capabilityOwner = skills.find((descriptor) => descriptor.providers?.some((provider) => provider.capabilities?.includes(capability)));
if (capabilityOwner) {
  throw new Error(`capability ${capability} is already provided by ${capabilityOwner.skillId}; choose a more specific capability`);
}

const skillDirectory = path.join(ROOT, "skills", name);
try {
  await stat(skillDirectory);
  throw new Error(`skill already exists: ${name}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
await mkdir(path.join(ROOT, "tests", name), { recursive: true });

await writeFile(path.join(skillDirectory, "SKILL.md"), `---\nname: ${name}\ndescription: ${capability} 기능이 필요한 요청을 처리한다. 관련 기능이 필요하지 않은 일반 작업에는 사용하지 않는다.\nmetadata:\n  version: 0.1.0\n---\n\n# ${name}\n\n요청의 목표와 권한 범위 안에서 ${capability} 결과를 만든다.\n\n## 입력\n\n- 목표와 수용 기준\n- 적용할 제약과 사용 가능한 근거\n\n## 출력\n\n결과, 검증 근거, 남은 제약을 구분해 반환한다.\n`, "utf8");
await writeFile(path.join(skillDirectory, "agents", "openai.yaml"), `interface:\n  display_name: "${name}"\n  short_description: "${capability} 작업을 수행하는 전문 스킬"\n  default_prompt: "Use $${name} to handle this ${capability} task."\npolicy:\n  allow_implicit_invocation: true\n`, "utf8");
await writeFile(path.join(ROOT, "tests", name, "cases.json"), `${JSON.stringify({
  normal: [{ id: "normal-01", expected: "returns a result with verification evidence" }],
  boundary: [{ id: "boundary-01", expected: "preserves the caller's authorization boundary" }],
  failure: [{ id: "failure-01", expected: "reports a blocker instead of inventing missing input" }]
}, null, 2)}\n`, "utf8");

skills.push({
  schemaVersion: "2.0.0",
  skillId: name,
  version: "0.1.0",
  path: `./${name}`,
  priority: 50,
  enabled: true,
  providers: [{
    capabilities: [capability],
    executionClass: "workflow",
    phase,
    phaseOrder: 50,
    requiredInputArtifacts: [],
    inputBindings: [],
    producedArtifacts: [],
    outputSchema: "contracts/freeform-output.v1.schema.json",
    resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: {
      default: { state: "passed", errorRequired: false },
      adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"]
    },
    selectionCriteria: [`requires-${capability}`],
    preconditions: [],
    failureHandling: "Return a structured provider result.",
    gate: { kind: "none", policy: "none", validator: null }
  }]
});
await writeFile(registryPath, `${JSON.stringify(registryDocument, null, 2)}\n`, "utf8");
console.log(`created skills/${name}`);
