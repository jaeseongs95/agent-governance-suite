import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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

export function readFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("SKILL.md must begin with YAML frontmatter.");
  }
  const values = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const field = line.match(/^([a-zA-Z0-9_-]+):\s*(.+)$/u);
    if (field) {
      values[field[1]] = field[2].trim().replace(/^(["'])(.*)\1$/u, "$2");
    }
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
