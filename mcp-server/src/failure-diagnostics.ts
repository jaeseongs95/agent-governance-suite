import { createHash } from "node:crypto";
import { types } from "node:util";

const producerReasons = new WeakMap<object, string>();
const producerCauses = new WeakMap<object, unknown>();
const secondaryFailures = new WeakMap<object, readonly unknown[]>();

/** Tag an existing producer Error without changing its public class, code or details. */
export function tagProducerFailure<T extends Error>(error: T, reason: string): T {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) throw new TypeError("Invalid diagnostic reason.");
  if (!producerReasons.has(error)) producerReasons.set(error, reason);
  return error;
}

/** Private links retain actual errors, not copied message/code strings. Never execution authority. */
export function retainFailureCause<T extends Error>(error: T, cause: unknown): T {
  if (!producerCauses.has(error)) producerCauses.set(error, cause);
  return error;
}

export function retainFailureSecondary<T>(error: T, secondary: unknown): T {
  if (error && (typeof error === "object" || typeof error === "function") && error !== secondary) {
    const prior = secondaryFailures.get(error as object) ?? [];
    if (prior.length < 2 && !prior.includes(secondary)) secondaryFailures.set(error as object, [...prior, secondary]);
  }
  return error;
}

/** Same-module diagnostic provenance only; never identity, capability or execution authority. */
export function producerFailure(reason: string, message: string): Error & { readonly code: string } {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) throw new TypeError("Invalid diagnostic reason.");
  const error = new Error(message) as Error & { readonly code: string };
  Object.defineProperty(error, "code", { value: reason, enumerable: true });
  producerReasons.set(error, reason);
  return error;
}

export function producerFailureReason(error: unknown): string | null {
  return error && (typeof error === "object" || typeof error === "function")
    ? producerReasons.get(error as object) ?? null : null;
}

/**
 * Bounded diagnostic correlation, not encryption, secrecy or a complete error identity.
 * Reads own data descriptors only. No message, stack, paths, input or unknown code text is emitted.
 */
export function failureContext(error: unknown): Record<string, unknown> {
  const seen = new Set<object>();
  function describe(value: unknown, depth: number): Record<string, unknown> {
    const type = value === null ? "null" : typeof value;
    if (!value || (typeof value !== "object" && typeof value !== "function")) return { type };
    if (types.isProxy(value)) return { type, opaque: "proxy" };
    if (seen.has(value)) return { type, cycle: true };
    seen.add(value);
    try {
      // A prototype may itself be a Proxy. Compare only the immediate prototype; never walk it.
      const prototype = Object.getPrototypeOf(value);
      const context: Record<string, unknown> = {
        type: prototype === SyntaxError.prototype ? "syntax-error" : prototype === TypeError.prototype ? "type-error"
          : prototype === RangeError.prototype ? "range-error" : types.isNativeError(value) ? "error" : type,
      };
      const producerReason = producerFailureReason(value);
      if (producerReason) context.producerReason = producerReason;
      if (producerCauses.has(value)) context.producerCause = depth < 2 ? describe(producerCauses.get(value), depth + 1) : { truncated: true };
      const secondary = secondaryFailures.get(value);
      if (secondary) context.secondary = depth < 2 ? secondary.map(error => describe(error, depth + 1)) : { truncated: true };
      const code = Object.getOwnPropertyDescriptor(value, "code");
      if (code) {
        if (!("value" in code)) context.code = { type: "accessor", observed: false };
        else if (typeof code.value === "string") {
          const prefix = code.value.slice(0, 256);
          context.code = { type: "string", length: code.value.length,
            prefixCodeUnits: prefix.length, truncated: prefix.length !== code.value.length, encoding: "utf16le",
            prefixSha256: createHash("sha256").update(Buffer.from(prefix, "utf16le")).digest("hex") };
        } else context.code = { type: code.value === null ? "null" : typeof code.value, observed: false };
      }
      // Only this documented SQLite error-code namespace may expose numeric diagnostics.
      // Other numeric/boolean code values are not treated as secret-safe hashes.
      if (code && "value" in code && code.value === "ERR_SQLITE_ERROR") {
        const detail = Object.getOwnPropertyDescriptor(value, "errcode");
        if (detail && !("value" in detail)) context.sqlite = { type: "accessor", observed: false };
        else if (detail && Number.isInteger(detail.value) && detail.value >= 1 && detail.value <= 65535
          && (detail.value & 255) >= 1 && (detail.value & 255) <= 28) {
          context.sqlite = { errcode: detail.value, primaryCode: detail.value & 255 };
        } else context.sqlite = { observed: false };
      }
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause) {
        if (!("value" in cause)) context.cause = { type: "accessor", observed: false };
        else context.cause = depth < 2 ? describe(cause.value, depth + 1) : { truncated: true };
      }
      return context;
    } catch { return { type, unreadable: true }; }
    finally { seen.delete(value); }
  }
  return describe(error, 0);
}
