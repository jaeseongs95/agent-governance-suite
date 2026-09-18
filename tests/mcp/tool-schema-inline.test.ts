import { describe, expect, it } from "vitest";

import { inlineSchemaReferences } from "../../mcp-server/src/tool-schema-inline.js";

const base = "https://example.test/contracts/";

describe("inlineSchemaReferences", () => {
  it("resolves absolute, relative and local references against each document", () => {
    const item = {
      $id: `${base}item.v1.schema.json`,
      type: "object",
      properties: { size: { $ref: "#/$defs/size" } },
      $defs: { size: { type: "integer", minimum: 1 } },
    };
    const root = {
      $id: `${base}root.v1.schema.json`,
      type: "object",
      properties: {
        absolute: { $ref: `${base}item.v1.schema.json` },
        relative: { $ref: "item.v1.schema.json" },
        local: { $ref: "#/$defs/name" },
      },
      $defs: { name: { type: "string" } },
    };
    const inlined = inlineSchemaReferences(root, [item]);
    const expectedItem = { type: "object", properties: { size: { type: "integer", minimum: 1 } } };
    expect(inlined).toEqual({
      type: "object",
      properties: { absolute: expectedItem, relative: expectedItem, local: { type: "string" } },
    });
  });

  it("keeps property names that look like keywords", () => {
    const root = {
      type: "object",
      properties: { $id: { type: "string" }, definitions: { $ref: "#/$defs/list" } },
      $defs: { list: { type: "array" } },
    };
    expect(inlineSchemaReferences(root, [])).toEqual({
      type: "object",
      properties: { $id: { type: "string" }, definitions: { type: "array" } },
    });
  });

  it("merges annotations but combines constraining siblings with allOf", () => {
    const root = {
      type: "object",
      properties: {
        annotated: { $ref: "#/$defs/text", description: "Shown to the model." },
        constrained: { $ref: "#/$defs/text", maxLength: 3 },
      },
      $defs: { text: { type: "string", minLength: 1 } },
    };
    expect(inlineSchemaReferences(root, [])).toEqual({
      type: "object",
      properties: {
        annotated: { type: "string", minLength: 1, description: "Shown to the model." },
        constrained: { allOf: [{ type: "string", minLength: 1 }, { maxLength: 3 }] },
      },
    });
  });

  it("reads JSON Pointer fragments literally, including the empty member name", () => {
    const root = {
      type: "object",
      properties: { empty: { $ref: "#/$defs/" }, escaped: { $ref: "#/$defs/a~1b" } },
      $defs: { "": { type: "null" }, "a/b": { type: "boolean" } },
    };
    expect(inlineSchemaReferences(root, [])).toEqual({
      type: "object",
      properties: { empty: { type: "null" }, escaped: { type: "boolean" } },
    });
  });

  it("refuses recursive and unknown references instead of emitting a wrong schema", () => {
    const recursive = { type: "object", properties: { node: { $ref: "#/$defs/node" } }, $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } } };
    expect(() => inlineSchemaReferences(recursive, [])).toThrow(/Recursive/u);
    expect(() => inlineSchemaReferences({ properties: { x: { $ref: `${base}missing.json` } } }, [])).toThrow(/Unknown schema reference/u);
    expect(() => inlineSchemaReferences({ properties: { x: { $ref: "#/$defs/missing" } }, $defs: {} }, [])).toThrow(/Unresolvable/u);
  });
});
