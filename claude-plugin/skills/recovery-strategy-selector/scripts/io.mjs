import { readFile } from "node:fs/promises";

export async function readJsonInput(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8"));
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error("stdin 또는 --input으로 JSON 입력이 필요합니다.");
  return JSON.parse(raw);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
