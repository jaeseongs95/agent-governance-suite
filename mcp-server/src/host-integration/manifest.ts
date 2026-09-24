import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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
  /** Package content consistency only; this is not an external trust anchor. */
  artifacts?: { path: string; sha256: string }[];
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
  const closure = new Set<string>();
  for (const entry of manifest.entryPoints) {
    if (ids.has(entry.id)) throw new Error(`Duplicate entry point: ${entry.id}`);
    ids.add(entry.id);
    resolvePackageFile(root, entry.path);
    if (!entry.executionClosure.includes(entry.path)) throw new Error(`Execution closure omits entry point: ${entry.id}`);
    for (const file of entry.executionClosure) {
      resolvePackageFile(root, file);
      closure.add(file);
    }
  }
  if (manifest.artifacts) {
    const seen = new Set<string>();
    for (const artifact of manifest.artifacts) {
      const file = resolvePackageFile(root, artifact.path);
      if (!closure.has(artifact.path) || seen.has(artifact.path)) {
        throw new Error(`Artifact path is not unique in the execution closure: ${artifact.path}`);
      }
      seen.add(artifact.path);
      const actual = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
      if (actual !== artifact.sha256) throw new Error(`Artifact hash mismatch: ${artifact.path}`);
    }
    if (seen.size !== closure.size) throw new Error("Artifact hashes do not cover the execution closure");
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
  const artifacts = [...new Set(entryPoints.flatMap((entry) => entry.executionClosure))]
    .sort()
    .map((file) => ({
      path: file,
      sha256: `sha256:${createHash("sha256").update(readFileSync(resolvePackageFile(root, file))).digest("hex")}`,
    }));
  const manifest: HostIntegrationManifest = { format: HOST_INTEGRATION_FORMAT, artifacts, entryPoints };
  parseHostIntegrationManifest(manifest, root);
  return { manifest, disabledEntryPoints };
}

function filesIn(root: string, directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = `${directory}/${entry.name}`;
      return entry.isDirectory() ? filesIn(root, relative) : entry.isFile() ? [relative] : [];
    });
}

/** Emit only the packaged direct MCP surface. Other VM entry points are separate tasks. */
export function buildCurrentHostIntegrationManifest(rootDirectory: string): HostIntegrationManifest {
  const root = realpathSync(rootDirectory);
  const mcp = JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")) as {
    mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string }>;
  };
  const server = mcp.mcpServers?.["agent-governance-suite"];
  if (server?.command !== "node" || server.args?.length !== 1
    || server.args[0] !== "mcp-server/dist/server.mjs" || server.cwd !== ".") {
    throw new Error("Packaged MCP configuration does not match the direct server entry point");
  }
  const plugin = JSON.parse(readFileSync(path.join(root, ".codex-plugin/plugin.json"), "utf8")) as {
    id: string; version: string;
  };
  const registry = JSON.parse(readFileSync(path.join(root, "skills/registry.json"), "utf8")) as {
    skills: { providers: { outputSchema: string; resultSchema: string; gate?: { validator?: string } }[] }[];
  };
  const providerSchemas = registry.skills.flatMap((skill) => skill.providers.flatMap((provider) =>
    [provider.outputSchema, provider.resultSchema, provider.gate?.validator]
      .filter((file): file is string => typeof file === "string" && file.endsWith(".schema.json"))));
  const executionClosure = [...new Set([
    ".mcp.json",
    ".codex-plugin/plugin.json",
    "mcp-server/dist/server.mjs",
    "mcp-server/dist/session-message-broker.mjs",
    "runtime/schema-validation.mjs",
    "skills/registry.json",
    "skills/korean-prose-editor/resources/korean-prose-glossary.sqlite3",
    ...filesIn(root, "contracts").filter((file) => file.endsWith(".json")),
    ...filesIn(root, "skills/coordinate-subagents/references/model-catalog"),
    ...providerSchemas,
  ])].sort();
  for (const file of executionClosure) resolvePackageFile(root, file);
  const descriptor = buildHostIntegrationDescriptor(root, [{
    id: "mcp-server", path: "mcp-server/dist/server.mjs", executionClosure, enabled: true,
  }]);
  const manifest = { ...descriptor.manifest, plugin: { id: plugin.id, version: plugin.version } };
  return parseHostIntegrationManifest(manifest, root);
}
