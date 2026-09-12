import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const SCHEMA_VERSION = "1.0.0";

/** @param {string} value */
export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @param {unknown} value @param {string} label */
export function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError("INVALID_OBJECT", `${label} must be an object`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

export class ContractError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

/** @param {NodeJS.ReadableStream} [stream] */
export async function readJsonInput(stream = process.stdin) {
  let body = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) body += chunk;
  if (body.trim() === "") throw new ContractError("EMPTY_INPUT", "JSON input is required");
  return JSON.parse(body);
}

/** @param {string} path */
export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {unknown} value */
export function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

/** @param {unknown} value @returns {unknown} */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

/** @param {unknown} value */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
