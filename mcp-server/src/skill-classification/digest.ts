import {createHash} from "node:crypto";

/** Stable JSON without coercion, Unicode normalization or schema initialization. */
export function digestClassificationValue(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (typeof item === "object" && item && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(",")}}`;
    }
    throw new Error("INVALID_JSON_VALUE");
  };
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}
