import { createHash } from "node:crypto";
import { types } from "node:util";

const producerReasons = new WeakMap();
const producerCauses = new WeakMap();
const secondaryFailures = new WeakMap();

/** Tag an existing producer Error without changing its public class, code or details. */
export function tagProducerFailure(error, reason) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) throw new TypeError("Invalid diagnostic reason.");
  if (!producerReasons.has(error)) producerReasons.set(error, reason);
  return error;
}

/** Private links retain actual errors, not copied message/code strings. Never execution authority. */
export function retainFailureCause(error, cause) {
  if (!producerCauses.has(error)) producerCauses.set(error, cause);
  return error;
}

export function retainFailureSecondary(error, secondary) {
  if (error && (typeof error === "object" || typeof error === "function") && error !== secondary) {
    const prior = secondaryFailures.get(error) ?? [];
    if (prior.length < 2 && !prior.includes(secondary)) secondaryFailures.set(error, [...prior, secondary]);
  }
  return error;
}

/** Cleanup after a primary failure: a cleanup failure never replaces the primary, it is kept only as a tagged secondary diagnostic. */
export function retainCleanupFailure(primary, reason, cleanup) {
  try { cleanup(); return true; }
  catch (secondary) {
    retainFailureSecondary(primary, types.isNativeError(secondary) ? tagProducerFailure(secondary, reason) : secondary);
    return false;
  }
}

/** A bounded own `code` data property (ENOENT, ERR_SQLITE_ERROR, a producer code), else null. Local diagnostics only. */
export function failureCode(error) {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function") || types.isProxy(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      && /^[A-Z][A-Z0-9_]{0,63}$/u.test(descriptor.value) ? descriptor.value : null;
  } catch { return null; }
}

// Fixed public vocabulary: these OS codes and SQLite classes may appear in public details and stderr diagnostics.
const OBSERVED_OS_CODES = new Set(["EACCES", "EPERM", "EIO", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "ENOSPC", "EROFS",
  "EMFILE", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"]);
const SQLITE_REASONS = Object.freeze({ 3: "STORE_PERMISSION", 5: "STORE_BUSY", 6: "STORE_BUSY", 8: "STORE_READONLY",
  10: "STORE_IO", 11: "STORE_CORRUPT", 13: "STORE_FULL", 14: "STORE_CANTOPEN", 19: "STORE_CONSTRAINT", 26: "STORE_CORRUPT" });

/**
 * One classification for every producer: an observed OS/SQLite/JSON class first, then the producer's own reason.
 * The result is a fixed vocabulary; null means the cause carries nothing classifiable.
 */
export function failureReason(error) {
  let observed = null;
  try {
    if (error && typeof error === "object" && !types.isProxy(error)) {
      if (Object.getPrototypeOf(error) === SyntaxError.prototype) observed = "INVALID_JSON";
      else {
        const code = failureCode(error);
        if (code && OBSERVED_OS_CODES.has(code)) observed = code;
        else if (code === "ERR_SQLITE_ERROR") {
          const detail = Object.getOwnPropertyDescriptor(error, "errcode");
          const primary = detail && "value" in detail && Number.isInteger(detail.value) ? detail.value & 255 : null;
          if (primary !== null && primary >= 1 && primary <= 28) observed = SQLITE_REASONS[primary] ?? "STORE_ERROR";
        }
      }
    }
  } catch { /* Unreadable error properties are not trusted diagnostics. */ }
  if (observed) return { reason: observed, basis: "unverified-observation" };
  const owned = producerFailureReason(error);
  return owned ? { reason: owned, basis: "producer" } : { reason: null, basis: "unknown" };
}

/** Same-module diagnostic provenance only; never identity, capability or execution authority. */
export function producerFailure(reason, message) {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) throw new TypeError("Invalid diagnostic reason.");
  const error = new Error(message);
  Object.defineProperty(error, "code", { value: reason, enumerable: true });
  producerReasons.set(error, reason);
  return error;
}

export function producerFailureReason(error) {
  return error && (typeof error === "object" || typeof error === "function")
    ? producerReasons.get(error) ?? null : null;
}

/**
 * Bounded diagnostic correlation, not encryption, secrecy or a complete error identity.
 * Reads own data descriptors only. No message, stack, paths, input or unknown code text is emitted.
 */
export function failureContext(error) {
  const seen = new Set();
  function describe(value, depth) {
    const type = value === null ? "null" : typeof value;
    if (!value || (typeof value !== "object" && typeof value !== "function")) return { type };
    if (types.isProxy(value)) return { type, opaque: "proxy" };
    if (seen.has(value)) return { type, cycle: true };
    seen.add(value);
    try {
      // A prototype may itself be a Proxy. Compare only the immediate prototype; never walk it.
      const prototype = Object.getPrototypeOf(value);
      const context = {
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
