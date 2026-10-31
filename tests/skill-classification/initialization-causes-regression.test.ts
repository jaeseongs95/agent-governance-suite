import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {readClassificationRuntime} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadProviderProfileRegistry} from "../../mcp-server/src/skill-classification/profile-validation.js";
import {ClassificationInitializationError, classificationInitializationFailureReason, loadClassificationProviderRuntime, reportClassificationInitializationFailure} from "../../mcp-server/src/skill-classification/runtime.js";

// 구현 전 고정 계획: ../jev-d0068-cause-repair-20261101-r02-evidence/plan.json.
// 실제 파일 로더의 행동을 판별한다. 네트워크·모델·인증·시계 대체는 필요하지 않다.
const directories: string[] = [];
afterEach(async () => {for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});});
const registry = {schemaVersion: "1.0.0", profileRevision: "fixture", profiles: []};
const loaders = [
  {name: "설정", load: (file: string) => readClassificationRuntime(file, path.dirname(file)),
    valid: {config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "PRIVATE_REGISTRY.json", externalClassificationAllowed: false, configRevision: "fixture", timeoutMs: 1000}, allowRemotePrivateContent: false},
    sizeCode: "CLASSIFICATION_CONFIG_TOO_LARGE", schemaCode: "CLASSIFICATION_CONFIGURATION_SCHEMA_INVALID"},
  {name: "프로필", load: loadProviderProfileRegistry, valid: registry,
    sizeCode: "PROVIDER_PROFILE_REGISTRY_TOO_LARGE", schemaCode: "INVALID_PROVIDER_PROFILE_REGISTRY"},
  {name: "공급자", load: loadClassificationProviderRuntime,
    valid: {schemaVersion: "1.0.0", routes: [], budget: {jev: {limitUsd: 5, spentUsd: 0}, vendors: {}, nativeAllowances: {}}},
    sizeCode: "CLASSIFICATION_RUNTIME_TOO_LARGE", schemaCode: "CLASSIFICATION_CONFIGURATION_SCHEMA_INVALID"},
];
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "ags-initialization-causes-")); directories.push(value);
  await writeFile(path.join(value, "PRIVATE_REGISTRY.json"), JSON.stringify(registry), "utf8");
  return value;
}
function expectSafeFailure(source: unknown, expected: string, privatePath?: string) {
  const wrapped = new ClassificationInitializationError(source), report = vi.fn();
  expect(classificationInitializationFailureReason(source)).toBe(expected);
  expect(wrapped).toMatchObject({phase: "classification-initialization", message: expected});
  expect(wrapped).not.toHaveProperty("cause");
  expect(new ClassificationInitializationError(wrapped).message).toBe(expected);
  reportClassificationInitializationFailure(source, report);
  reportClassificationInitializationFailure(wrapped, report);
  expect(report.mock.calls).toEqual([[{phase: "classification-initialization", reason: expected}], [{phase: "classification-initialization", reason: expected}]]);
  const visible = JSON.stringify({wrapped, reports: report.mock.calls});
  expect(visible).not.toContain("PRIVATE_");
  if (privatePath) expect(visible).not.toContain(privatePath);
}

describe.each(loaders)("D0068 실제 $name 로더 원인", loader => {
  it.each(["읽기", "JSON", "형상", "크기"] as const)("CAUSE %s 실패를 닫힌 원인으로 보존한다", async kind => {
    const root = await directory(), file = path.join(root, "PRIVATE_INPUT.json");
    if (kind !== "읽기") await writeFile(file, kind === "크기" ? " ".repeat(1024 * 1024 + 1) : kind === "JSON" ? '{"PRIVATE_KEY":"PRIVATE_BODY",' : JSON.stringify({PRIVATE_KEY: "PRIVATE_BODY"}), "utf8");
    const expected = kind === "읽기" ? "CLASSIFICATION_CONFIGURATION_READ_FAILED" : kind === "JSON" ? "CLASSIFICATION_CONFIGURATION_JSON_INVALID" : kind === "형상" ? loader.schemaCode : loader.sizeCode;
    // Linux/Windows의 없는 파일(open)과 디렉터리(read)에서 실제 파일 오류를 만든다.
    for (const target of kind === "읽기" ? [file, root] : [file]) {
      let failure: unknown;
      try {await loader.load(target);} catch (error) {failure = error;}
      expect(failure).toBeDefined();
      expectSafeFailure(failure, expected, root);
    }
  });
  it("VALID 정상 파일은 실패로 바꾸지 않는다", async () => {
    const root = await directory(), file = path.join(root, "PRIVATE_VALID.json");
    await writeFile(file, JSON.stringify(loader.valid), "utf8");
    await expect(loader.load(file)).resolves.toBeDefined();
  });
});

describe("D0068 불투명 오류의 기존 보안 경계", () => {
  it("PRIVATE 임의 원문·이름·파일 오류 모양 객체는 일반 원인으로 남긴다", () => {
    for (const source of ["PRIVATE_BODY", new Error("PRIVATE_BODY"),
      Object.assign(new Error("PRIVATE_BODY"), {name: "SyntaxError"}),
      Object.assign(new Error("PRIVATE_BODY"), {name: "ZodError"}),
      {message: "PRIVATE_BODY", code: "ENOENT", syscall: "open"},
      Object.assign(new Error("PRIVATE_BODY"), {code: "ENOENT", syscall: "fetch"}),
      Object.create(SyntaxError.prototype),
      Object.assign(new Error("PRIVATE_BODY"), {_zod: {constr: () => "PRIVATE_BODY"}}),
    ]) expectSafeFailure(source, "CLASSIFICATION_CONFIGURATION_UNAVAILABLE");
  });
  it("PRIVATE 접근자·프록시·중첩 접근자를 실행하지 않는다", () => {
    const getter = vi.fn(() => {throw new Error("PRIVATE_GETTER");});
    const trap = vi.fn(() => {throw new Error("PRIVATE_PROXY");});
    const proxy = new Proxy({}, {get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap, has: trap});
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    const accessors = Object.defineProperties(new Error("PRIVATE_BODY"), {
      message: {get: getter}, code: {get: getter}, syscall: {get: getter}, _zod: {get: getter},
    });
    const internals = Object.defineProperty({}, "constr", {get: getter});
    for (const source of [accessors, proxy, revoked.proxy,
      Object.assign(new Error("PRIVATE_BODY"), {_zod: proxy}),
      Object.assign(new Error("PRIVATE_BODY"), {_zod: internals}),
    ]) expectSafeFailure(source, "CLASSIFICATION_CONFIGURATION_UNAVAILABLE");
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });
  it("PRIVATE 진단 수신기의 실패는 원래처럼 전파하지 않는다", () => {
    expect(() => reportClassificationInitializationFailure(new Error("PRIVATE_BODY"), () => {throw new Error("PRIVATE_SINK");})).not.toThrow();
  });
});
