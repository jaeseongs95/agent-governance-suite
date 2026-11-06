export class InputError extends Error {
  constructor(message: string, details?: unknown);
  details: unknown;
}
export function canonicalJson(value: unknown): string;
export function sha256(value: unknown): string;
export function authorityEvidenceDigest(evidence: Record<string, unknown>, authorityValue: string): string;
export function assertTaskEnvelope(task: unknown): void;
export function analyzeAcceptance(input: unknown): Record<string, unknown>;
export function validateReport(validation: unknown): string[];
export function validateReportAgainstRequest(report: unknown, request: unknown): string[];
