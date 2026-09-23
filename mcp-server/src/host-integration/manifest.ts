import { Ajv2020 } from "ajv/dist/2020.js";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { contractSchemas } from "../schema-validator.js";

export const HOST_INTEGRATION_FORMAT = "agent-governance-suite.host-integration.v1";

export type HostIntegrationEntryPointId =
  | "mcp-server" | "host-attestation-cli" | "scope-baseline" | "scope-compare" | "acceptance-cli";

export interface HostIntegrationEntryPoint {
  id: HostIntegrationEntryPointId;
  path: string;
  executionClosure: string[];
}

export interface HostIntegrationManifest {
  format: typeof HOST_INTEGRATION_FORMAT;
  plugin?: { id: string; version: string };
  entryPoints: HostIntegrationEntryPoint[];
}

/** Builder-only availability, deliberately outside the VM manifest wire format. */
export interface HostIntegrationCandidate extends HostIntegrationEntryPoint {
  enabled: boolean;
}

const validate = new Ajv2020({ allErrors: true }).compile(contractSchemas.hostIntegration);

function resolvePackageFile(root: string, relativePath: string): string {
  if (relativePath.includes("\\") || relativePath.includes(":") || relativePath.startsWith("/")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid package-relative path: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  let actual: string;
  try {
    actual = realpathSync(target);
    if (!statSync(actual).isFile()) throw new Error("not a regular file");
  } catch {
    throw new Error(`Missing package file: ${relativePath}`);
  }
  const relative = path.relative(root, actual);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Package path escapes root: ${relativePath}`);
  }
  return actual;
}

/** Parse a proposed manifest and verify every advertised file inside the package root. */
export function parseHostIntegrationManifest(input: unknown, rootDirectory: string): HostIntegrationManifest {
  if (!validate(input)) throw new Error(`Invalid host-integration manifest: ${JSON.stringify(validate.errors)}`);
  const manifest = input as HostIntegrationManifest;
  const root = realpathSync(rootDirectory);
  const ids = new Set<string>();
  for (const entry of manifest.entryPoints) {
    if (ids.has(entry.id)) throw new Error(`Duplicate entry point: ${entry.id}`);
    ids.add(entry.id);
    resolvePackageFile(root, entry.path);
    if (!entry.executionClosure.includes(entry.path)) throw new Error(`Execution closure omits entry point: ${entry.id}`);
    for (const file of entry.executionClosure) resolvePackageFile(root, file);
  }
  return manifest;
}

/** Only enabled candidates whose declared closure exists are advertised. This is not an execution check. */
export function buildHostIntegrationDescriptor(rootDirectory: string, candidates: readonly HostIntegrationCandidate[]): {
  manifest: HostIntegrationManifest;
  disabledEntryPoints: HostIntegrationEntryPointId[];
} {
  const root = realpathSync(rootDirectory);
  const entryPoints: HostIntegrationEntryPoint[] = [];
  const disabledEntryPoints: HostIntegrationEntryPointId[] = [];
  for (const candidate of candidates) {
    if (!candidate.enabled) {
      disabledEntryPoints.push(candidate.id);
      continue;
    }
    try {
      resolvePackageFile(root, candidate.path);
      for (const file of candidate.executionClosure) resolvePackageFile(root, file);
      entryPoints.push({ id: candidate.id, path: candidate.path, executionClosure: [...candidate.executionClosure] });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Missing package file:")) throw error;
      disabledEntryPoints.push(candidate.id);
    }
  }
  const manifest: HostIntegrationManifest = { format: HOST_INTEGRATION_FORMAT, entryPoints };
  parseHostIntegrationManifest(manifest, root);
  return { manifest, disabledEntryPoints };
}
