import { readFile } from "node:fs/promises";

export async function readJsonArgument(argv, name = "--input") {
  const index = argv.indexOf(name);
  if (index >= 0) {
    const file = argv[index + 1];
    if (!file) throw new Error(`${name} requires a file path.`);
    return JSON.parse(await readFile(file, "utf8"));
  }
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("Expected JSON on stdin or an input file argument.");
  return JSON.parse(raw);
}

export function writeJson(value, stream = process.stdout) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}
