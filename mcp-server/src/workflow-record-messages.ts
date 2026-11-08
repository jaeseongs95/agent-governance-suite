import { msg, render, SUPPORTED_LOCALES, type MessageRef, type StoredMessageRef } from "./i18n.js";

/**
 * Sentences a workflow record keeps (docs/contributing/i18n.md 3.2). TaskEnvelope.constraints is a signed string list, so the
 * record holds the root-locale text; readers map a known text back to its key and params here and render it themselves.
 */
export const LATE_ADOPTION_LABEL = msg("workflowRecord.lateAdoption.label", {});

export function lateAdoptionConstraint(priorFileCount: number): MessageRef<"workflowRecord.lateAdoption.constraint"> {
  return msg("workflowRecord.lateAdoption.constraint", { priorFileCount });
}

/**
 * The key and params of a stored record sentence written in any shipped locale, or null for other text.
 * Rows stored before the catalog hold the Korean text, which is the ko source byte for byte, so they map too.
 */
export function recordMessageRef(text: string): StoredMessageRef | null {
  if (SUPPORTED_LOCALES.some(locale => render(LATE_ADOPTION_LABEL, locale) === text)) return LATE_ADOPTION_LABEL;
  const count = /\d+/u.exec(text);
  if (!count) return null;
  const ref = lateAdoptionConstraint(Number(count[0]));
  return SUPPORTED_LOCALES.some(locale => render(ref, locale) === text) ? ref : null;
}
