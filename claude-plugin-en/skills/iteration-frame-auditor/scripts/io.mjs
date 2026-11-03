import { readFile } from "node:fs/promises";

import { hostText } from "../../../runtime/i18n.mjs";

export async function readJsonArgument(args) {
  const inputIndex = args.indexOf("--input");
  if (inputIndex >= 0) {
    if (!args[inputIndex + 1]) throw new Error(hostText("skillTools.iterationFrame.flagNeedsPath", { flag: "--input" }));
    return JSON.parse(await readFile(args[inputIndex + 1], "utf8"));
  }

  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) body += chunk;
  if (body.trim().length === 0) throw new Error(hostText("skillTools.iterationFrame.jsonInputRequired"));
  return JSON.parse(body);
}

export function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
