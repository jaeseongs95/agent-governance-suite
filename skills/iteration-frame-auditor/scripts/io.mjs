import { readFile } from "node:fs/promises";

export async function readJsonArgument(args) {
  const inputIndex = args.indexOf("--input");
  if (inputIndex >= 0) {
    if (!args[inputIndex + 1]) throw new Error("--input requires a file path.");
    return JSON.parse(await readFile(args[inputIndex + 1], "utf8"));
  }

  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  if (body.trim().length === 0) throw new Error("JSON input is required on stdin or with --input.");
  return JSON.parse(body);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
