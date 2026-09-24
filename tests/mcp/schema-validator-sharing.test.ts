import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { describe, expect, it, vi } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { ContractValidator, contractSchemas } from "../../mcp-server/src/schema-validator.js";

const addFormats = addFormatsModule as unknown as FormatsPlugin;
type Validators = Readonly<Record<string, ((value: unknown) => boolean) & { errors?: unknown }>>;
const tableOf = (validator: ContractValidator): Validators =>
  (validator as unknown as { validators: Validators }).validators;

function rejection(run: () => unknown): WorkflowContractError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowContractError);
    return error as WorkflowContractError;
  }
  throw new Error("expected the contract validator to reject the value");
}

const emptySummary = { schemaVersion: "1.0.0", summary: "" };
const wrongVersion = { schemaVersion: "2.0.0", summary: "ok" };
const valid = { schemaVersion: "1.0.0", summary: "ok" };

describe("process-scoped contract validators", () => {
  it("reuses one frozen compiled table across instances", () => {
    const first = tableOf(new ContractValidator()), second = tableOf(new ContractValidator());
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first)).toEqual(expect.arrayContaining([
      ...Object.keys(contractSchemas),
      "checkpointEvidenceRef", "checkpointDeltaStateAck", "checkpointDeltaTransportAck", "continuitySnapshot",
    ]));
  });

  it("accepts and rejects exactly as a freshly compiled Ajv instance", () => {
    const fresh = new Ajv2020({ allErrors: true, strict: false });
    addFormats(fresh);
    for (const schema of Object.values(contractSchemas)) fresh.addSchema(structuredClone(schema));
    const shared = tableOf(new ContractValidator());
    const samples: unknown[] = [null, {}, [], "text", valid, emptySummary, { schemaVersion: "1.0.0" }];
    const references: Array<[string, string]> = [
      ...Object.entries(contractSchemas).map(([name, schema]): [string, string] => [name, schema.$id as string]),
      ["checkpointEvidenceRef", `${contractSchemas.checkpointContextRequest.$id as string}#/$defs/evidenceRef`],
      ["checkpointDeltaStateAck", `${contractSchemas.checkpointDelta.$id as string}#/$defs/stateAck`],
      ["checkpointDeltaTransportAck", `${contractSchemas.checkpointDelta.$id as string}#/$defs/transportAck`],
      ["continuitySnapshot", `${contractSchemas.checkpointDelta.$id as string}#/$defs/snapshot`],
    ];
    expect(references).toHaveLength(Object.keys(shared).length);
    for (const [name, reference] of references) {
      const expected = fresh.getSchema(reference)!;
      for (const sample of samples) {
        expect(shared[name]!(sample), name).toBe(expected(sample));
        expect(shared[name]!.errors ?? null, name).toEqual(expected.errors ?? null);
      }
    }
  });

  it("keeps each caller's diagnostics when instances interleave", async () => {
    const left = new ContractValidator(), right = new ContractValidator();
    const leftError = rejection(() => left.updateSessionStatusRequest(emptySummary));
    const rightError = rejection(() => right.updateSessionStatusRequest(wrongVersion));
    expect(left.updateSessionStatusRequest(valid)).toBe(valid);
    const again = rejection(() => left.updateSessionStatusRequest(emptySummary));
    expect(leftError.details?.validationErrors).toMatch(/^\/summary /u);
    expect(leftError.details?.validationErrors).not.toMatch(/schemaVersion/u);
    expect(rightError.details?.validationErrors).toMatch(/^\/schemaVersion /u);
    expect(rightError.details?.validationErrors).not.toMatch(/summary/u);
    expect(again.details).toEqual(leftError.details);

    const outcomes = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      await Promise.resolve();
      const validator = index % 2 === 0 ? left : right, value = index % 2 === 0 ? emptySummary : wrongVersion;
      return rejection(() => validator.updateSessionStatusRequest(value)).details?.validationErrors;
    }));
    outcomes.forEach((text, index) => expect(text).toBe(index % 2 === 0
      ? leftError.details?.validationErrors : rightError.details?.validationErrors));
  });

  it("compiles from a private snapshot that later edits to the exported schemas cannot reach", async () => {
    vi.resetModules();
    const isolated = await import("../../mcp-server/src/schema-validator.js");
    const summary = (isolated.contractSchemas.updateSessionStatusRequest as {
      properties: { summary: { maxLength: number } };
    }).properties.summary;
    const original = summary.maxLength;
    // The table compiles on first use, so an edit made before the first instance must not reach it.
    summary.maxLength = 1;
    try {
      const validator = new isolated.ContractValidator();
      expect(validator.updateSessionStatusRequest({ schemaVersion: "1.0.0", summary: "x".repeat(200) }).summary)
        .toHaveLength(200);
      expect(() => validator.updateSessionStatusRequest({ schemaVersion: "1.0.0", summary: "x".repeat(201) }))
        .toThrow(/does not match its v1 contract/u);
    } finally {
      summary.maxLength = original;
      vi.resetModules();
    }
  });
});
