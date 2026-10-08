import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClassificationRequest, digestClassificationValue, projectClassificationRequest, validateClassificationRequest } from "../../mcp-server/src/skill-classification/request.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import type { ConfirmedContext, SkillInventory } from "../../mcp-server/src/skill-classification/types.js";

const empty: SkillInventory = { skills: [], issues: [], taxonomyRevision: "1.0.0", inventoryDigest: `sha256:${"a".repeat(64)}` };
const input = { requestId: "r1", operationId: "op1", originalPrompt: "  인용: ‘수정한다’\r\n실제 요청은 읽기 전용, 수정 금지. e\u0301  ", inventory: empty, classificationCriteriaRef: "criteria:v1" };
describe("deterministic exact request and compact projection (SS21/SS28)", () => {
  it("retains exact bytes, negations, quotations and unknown context", () => {
    const request = createClassificationRequest(input);
    expect(request.originalPrompt).toBe(input.originalPrompt);
    expect(request.promptDigest).toBe(`sha256:${createHash("sha256").update(input.originalPrompt).digest("hex")}`);
    expect(request.confirmedContext).toEqual({ taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null });
    expect(createClassificationRequest(input)).toEqual(request);
    expect(() => validateClassificationRequest(request)).not.toThrow();
    expect(digestClassificationValue({ b: 1, a: "x" })).toBe(digestClassificationValue({ a: "x", b: 1 }));
    expect(createClassificationRequest({ ...input, originalPrompt: input.originalPrompt.normalize("NFC") }).requestDigest).not.toBe(request.requestDigest);
  });
  it("preserves confirmed empty values and separate prohibited actions with provenance", () => {
    const confirmedContext = { objective: "", actions: [], constraints: ["허용된 대상만"], prohibitedActions: ["modify", "publish"] };
    const contextSources = Object.keys(confirmedContext).map((field) => ({ field, reference: `task:v1/${field}` }));
    const request = createClassificationRequest({ ...input, confirmedContext, contextSources });
    expect(request.confirmedContext).toMatchObject(confirmedContext);
    const projection = projectClassificationRequest(request);
    expect(projection.payload.confirmedContext).toEqual(request.confirmedContext);
    expect(projection.payload.confirmedContext.targets).toBeNull();
    expect(() => createClassificationRequest({ ...input, confirmedContext })).toThrow("CONTEXT_SOURCE_MISSING");
    expect(() => createClassificationRequest({ ...input, confirmedContext: { objective: undefined } as unknown as Partial<ConfirmedContext> })).toThrow();
  });
  it("rejects non-JSON inputs and tampered prompt/context bindings", () => {
    expect(() => digestClassificationValue({ value: undefined })).toThrow("INVALID_JSON_VALUE");
    expect(() => digestClassificationValue(Number.NaN)).toThrow("INVALID_JSON_VALUE");
    expect(() => createClassificationRequest({ ...input, originalPrompt: 1 as unknown as string })).toThrow();
    const request = createClassificationRequest(input);
    expect(() => validateClassificationRequest({ ...request, originalPrompt: "수정 허용" })).toThrow("REQUEST_INTEGRITY_FAILED");
    expect(() => validateClassificationRequest({ ...request, confirmedContext: { ...request.confirmedContext, prohibitedActions: [] } })).toThrow("REQUEST_INTEGRITY_FAILED");
    const unsupportedContext = { ...request, confirmedContext: { ...request.confirmedContext, objective: "not sourced" } };
    const body = { ...unsupportedContext } as Partial<typeof unsupportedContext>;
    delete body.requestDigest;
    expect(() => validateClassificationRequest({ ...unsupportedContext, requestDigest: digestClassificationValue(body) })).toThrow("CONTEXT_SOURCE_MISSING");
  });
  it("rejects unknown request/input fields even when their digest is recomputed", () => {
    const request = createClassificationRequest(input);
    const extended = { ...request, credentials: { apiKey: "synthetic-secret" } };
    const body = { ...extended } as Partial<typeof extended>;
    delete body.requestDigest;
    expect(() => validateClassificationRequest({ ...extended, requestDigest: digestClassificationValue(body) })).toThrow();
    expect(() => createClassificationRequest({ ...input, credentials: { apiKey: "synthetic-secret" } } as Parameters<typeof createClassificationRequest>[0])).toThrow();
    expect(() => validateClassificationRequest({ ...request, requestId: "" })).toThrow();
    expect(() => createClassificationRequest({ ...input, inventory: { ...empty, credential: "synthetic-secret" } } as Parameters<typeof createClassificationRequest>[0])).toThrow();
  });
  it("keeps the last prohibition, every candidate, applicability, dependencies and phase gates", async () => {
    const inventory = await loadSkillInventory({ root: process.cwd() });
    const request = createClassificationRequest({ ...input, inventory, originalPrompt: `${"긴 입력 ".repeat(8000)}끝: 읽기 전용, 수정 금지` });
    const compact = projectClassificationRequest(request);
    expect(compact.payload.originalPrompt).toBe(request.originalPrompt);
    expect(compact.payload.skills).toHaveLength(inventory.skills.length);
    for (const [index, skill] of request.skills.entries()) {
      const semantic = { ...skill } as Partial<typeof skill>;
      delete semantic.sourceRefs;
      delete semantic.sourceMap;
      expect(compact.payload.skills[index]).toEqual(semantic);
    }
    expect(compact.payloadBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(request)));
    expect(JSON.stringify(compact.payload)).not.toContain('"sourceRefs"');
    expect(compact.omittedFields).toContain("contextSources");
    expect(() => projectClassificationRequest(request, compact.payloadBytes - 1)).toThrow("INPUT_TOO_LONG");
    expect(projectClassificationRequest(request, compact.payloadBytes).payload.originalPrompt.endsWith("수정 금지")).toBe(true);
    expect(() => projectClassificationRequest(request, Number.NaN)).toThrow("INVALID_INPUT_LIMIT");
  });
});
