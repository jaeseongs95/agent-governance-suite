export interface KoreanProseExecutionProvenance {
  requestedModel: string;
  actualModel: string;
  provider: string;
  providerVersion: string;
  promptSha256: string;
  seed: number | "unverified";
  decodingParametersSha256: string | "unverified";
}

const SHA256 = /^[a-f0-9]{64}$/u;
const UNVERIFIED = new Set(["unverified", "unknown", "n/a", "not-available"]);

export function assertConcreteKoreanProseExecutionProvenance(
  value: unknown,
  label: string,
): asserts value is KoreanProseExecutionProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} execution provenance is missing`);
  }
  const provenance = value as Record<string, unknown>;
  for (const field of ["requestedModel", "actualModel", "provider", "providerVersion"] as const) {
    const entry = provenance[field];
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${label} execution provenance is missing ${field}`);
    }
  }
  if (UNVERIFIED.has(String(provenance.actualModel).trim().toLowerCase())
    || UNVERIFIED.has(String(provenance.provider).trim().toLowerCase())
    || UNVERIFIED.has(String(provenance.providerVersion).trim().toLowerCase())) {
    throw new Error(`${label} execution provenance contains an unverified identity field`);
  }
  if (typeof provenance.promptSha256 !== "string" || !SHA256.test(provenance.promptSha256)) {
    throw new Error(`${label} execution provenance has an invalid prompt digest`);
  }
  if (!(Number.isInteger(provenance.seed) || provenance.seed === "unverified")) {
    throw new Error(`${label} execution provenance has an invalid seed`);
  }
  if (!(provenance.decodingParametersSha256 === "unverified"
    || (typeof provenance.decodingParametersSha256 === "string" && SHA256.test(provenance.decodingParametersSha256)))) {
    throw new Error(`${label} execution provenance has invalid decoding parameters`);
  }
}
