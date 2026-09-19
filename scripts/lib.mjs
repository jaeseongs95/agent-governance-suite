import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

export const ROOT = path.resolve(process.env.AGENT_GOVERNANCE_ROOT ?? path.join(import.meta.dirname, ".."));
export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token ?? ""}`);
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

/** False only when the path is missing; any other stat failure is rethrown. */
export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** The registry provider for a skill that declares no integration descriptor of its own. */
export function defaultProvider(capability, phase) {
  return {
    capabilities: [capability],
    executionClass: "workflow",
    phase,
    phaseOrder: 50,
    requiredInputArtifacts: [],
    inputBindings: [],
    producedArtifacts: [],
    outputSchema: "contracts/freeform-output.v1.schema.json",
    resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: {
      default: { state: "passed", errorRequired: false },
      adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"],
    },
    selectionCriteria: [`requires-${capability}`],
    preconditions: [],
    failureHandling: "Return a structured provider result.",
    gate: { kind: "none", policy: "none", validator: null },
  };
}

export function readFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("SKILL.md must begin with YAML frontmatter.");
  }
  const values = {};
  const lines = match[1].split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([a-zA-Z0-9_-]+):\s*(.+)$/u);
    if (!field) continue;
    const value = field[2].trim();
    // YAML block scalars (description: > or |) continue on the following indented lines.
    if (/^[>|][+-]?$/u.test(value)) {
      const block = [];
      while (index + 1 < lines.length && (/^\s+\S/u.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
        index += 1;
        block.push(lines[index].trim());
      }
      values[field[1]] = value.startsWith(">") ? block.filter(Boolean).join(" ") : block.join("\n").trim();
      continue;
    }
    values[field[1]] = value.replace(/^(["'])(.*)\1$/u, "$2");
  }
  return values;
}

export async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "__pycache__", "results"].includes(entry.name)) {
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

export async function computeDirectoryChecksum(directory) {
  const files = await walkFiles(directory);
  const checksum = createHash("sha256");
  for (const file of files.sort()) {
    checksum.update(path.relative(directory, file).split(path.sep).join("/"));
    checksum.update(normalizeChecksumContent(await readFile(file)));
  }
  return `sha256:${checksum.digest("hex")}`;
}

export function normalizeChecksumContent(content) {
  if (!isUtf8(content) || content.includes(0)) {
    return content;
  }

  return Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
}
