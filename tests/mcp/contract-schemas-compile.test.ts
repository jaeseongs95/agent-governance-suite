import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { ContractValidator, contractSchemas } from "../../mcp-server/src/schema-validator.js";

const addFormats = addFormatsModule as unknown as FormatsPlugin;

// T-0033: the contracts are compiled on first use and are not checked against their meta-schema at run time,
// so this is where a broken contract fails: before it ships, not on the first call that needs it.
type Asserting = { assert(name: string, value: unknown): unknown };
const assertOf = (validator: ContractValidator) => (validator as unknown as Asserting).assert.bind(validator);

describe("packaged contract schemas (T-0033)", () => {
  it.each(Object.keys(contractSchemas))("%s is valid against its meta-schema", (name) => {
    // The same check the server ran on start: with the formats it registers.
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(ajv.validateSchema(contractSchemas[name as keyof typeof contractSchemas]), JSON.stringify(ajv.errors)).toBe(true);
  });

  // An empty object is rejected or accepted by the contract; a schema that cannot compile throws something else.
  it.each([...Object.keys(contractSchemas), "stateCleanupRootProtection"])("%s compiles and reports a mismatch as a contract error", (name) => {
    const validator = new ContractValidator();
    expect((validator as unknown as { validator(name: string): unknown }).validator(name)).toBeTypeOf("function");
    try {
      assertOf(validator)(name, {});
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowContractError);
      expect((error as WorkflowContractError).code).toBe("INVALID_INPUT");
      expect((error as WorkflowContractError).details?.validationErrors).toBeDefined();
    }
  });

  it("does not build the schemas until one is needed, and reuses them after", () => {
    const validator = new ContractValidator();
    const state = validator as unknown as { contractAjv: unknown };
    expect(state.contractAjv).toBeUndefined();
    const validate = assertOf(validator);
    expect(() => validate("loadContextRequest", {})).toThrow(WorkflowContractError);
    const built = state.contractAjv;
    expect(built).toBeDefined();
    expect(() => validate("inspectContextRequest", {})).toThrow(WorkflowContractError);
    expect(state.contractAjv).toBe(built);
  });

  it("still names a contract that does not exist", () => {
    const validate = assertOf(new ContractValidator());
    expect(() => validate("noSuchContract", {})).toThrow(WorkflowContractError);
    expect(() => validate("__proto__", {})).toThrow(WorkflowContractError);
  });
});
