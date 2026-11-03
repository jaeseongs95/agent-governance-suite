import { readFile } from "node:fs/promises";
import { hostText } from "../../../runtime/i18n.mjs";

export async function readJsonInput(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--input");
  if (index >= 0) return JSON.parse(await readFile(argv[index + 1], "utf8"));
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw.trim()) throw new Error(hostText("skillChecksKo.recoveryStrategySelectorIo.jsonInputRequired"));
  return JSON.parse(raw);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
