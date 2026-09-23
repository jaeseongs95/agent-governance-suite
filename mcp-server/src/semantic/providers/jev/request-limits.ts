import type { SemanticModelOptionV1 } from "../../../../../contracts/types.js";

/** The documented Choice maximum. AGS can prepare 256 options. */
export const JEV_MAX_CHOICE_OPTIONS = 255;
/** Local HTTP body safety cap in UTF-8 bytes; TypeSafe does not publish a byte cap. */
export const JEV_MAX_REQUEST_BYTES = 256 * 1024;

export function checkJevChoiceCardinality(
  options: readonly SemanticModelOptionV1[],
): "unsupported-cardinality" | null {
  return options.length > JEV_MAX_CHOICE_OPTIONS ? "unsupported-cardinality" : null;
}

/** Check the exact requestText produced by J02 before HTTP dispatch. */
export function checkJevPayloadBytes(requestText: string): "unsupported-bytes" | null {
  return Buffer.byteLength(requestText, "utf8") > JEV_MAX_REQUEST_BYTES
    ? "unsupported-bytes" : null;
}
