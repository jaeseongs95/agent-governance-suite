/**
 * Claude Code cannot resolve JSON Schema references in advertised MCP tool
 * schemas: a property defined through an external `$ref` reaches the server as a
 * string instead of an object. For Anthropic hosts the advertised schemas are
 * therefore fully inlined. Validation always uses the exact contracts.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const ANNOTATION_ONLY_KEYS = new Set(["$schema", "$id", "$defs", "definitions"]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas"]);
// Keywords that only describe a schema; merging them next to a resolved reference keeps its meaning.
const ANNOTATION_KEYWORDS = new Set(["title", "description", "default", "examples", "$comment", "deprecated", "readOnly", "writeOnly"]);

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pointer(document: Json, fragment: string): Json {
  // An empty fragment is the whole document; "/" is the member named "" (RFC 6901).
  if (!fragment) return document;
  if (!fragment.startsWith("/")) throw new Error(`Unsupported schema fragment #${fragment}`);
  let current: Json = document;
  for (const raw of fragment.slice(1).split("/")) {
    const key = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current) && !Array.isArray(current)) throw new Error(`Unresolvable schema pointer #${fragment}`);
    current = (current as Record<string, Json>)[key] as Json;
    if (current === undefined) throw new Error(`Unresolvable schema pointer #${fragment}`);
  }
  return current;
}

export function inlineSchemaReferences(
  schema: Record<string, unknown>,
  documents: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  const byId = new Map<string, Json>();
  for (const document of documents) {
    if (typeof document.$id === "string") byId.set(document.$id, document as JsonObject);
  }
  const rootBase = typeof schema.$id === "string" ? schema.$id : "urn:agent-governance:tool-schema";
  byId.set(rootBase, schema as JsonObject);

  function inline(node: Json, base: string, active: ReadonlySet<string>): Json {
    if (Array.isArray(node)) return node.map((item) => inline(item, base, active));
    if (!isObject(node)) return node;
    const nodeBase = typeof node.$id === "string" ? new URL(node.$id, base).href : base;
    if (typeof node.$ref === "string") {
      const target = new URL(node.$ref, nodeBase);
      const fragment = target.hash.replace(/^#/u, "");
      target.hash = "";
      const documentId = target.href;
      const document = byId.get(documentId);
      if (document === undefined) throw new Error(`Unknown schema reference ${node.$ref}`);
      const key = `${documentId}#${fragment}`;
      if (active.has(key)) throw new Error(`Recursive schema reference ${key} cannot be inlined`);
      const resolved = inline(pointer(document, fragment), documentId, new Set([...active, key]));
      const siblings = Object.fromEntries(
        Object.entries(node)
          .filter(([name]) => name !== "$ref" && !ANNOTATION_ONLY_KEYS.has(name))
          .map(([name, value]) => [name, inline(value, nodeBase, active)]),
      );
      if (Object.keys(siblings).length === 0) return resolved;
      // In JSON Schema 2020-12 a $ref applies together with its siblings, so constraints are combined, not merged.
      const constraining = Object.keys(siblings).some((name) => !ANNOTATION_KEYWORDS.has(name));
      if (!constraining && isObject(resolved)) return { ...resolved, ...siblings };
      return { allOf: [resolved, siblings] };
    }
    const output: JsonObject = {};
    for (const [name, value] of Object.entries(node)) {
      if (ANNOTATION_ONLY_KEYS.has(name)) continue;
      // Keys of a property map are names, not keywords, so none of them is dropped.
      output[name] = SCHEMA_MAP_KEYS.has(name) && isObject(value)
        ? Object.fromEntries(Object.entries(value).map(([property, subschema]) => [property, inline(subschema, nodeBase, active)]))
        : inline(value, nodeBase, active);
    }
    return output;
  }

  return inline(schema as JsonObject, rootBase, new Set()) as Record<string, unknown>;
}
