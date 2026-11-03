import { readFileSync } from "node:fs";
import path from "node:path";

import { collaborationDecisionStructuralDiagnostic } from "./collaboration-decision.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

try {
  const input = process.argv[2]
    ? readFileSync(path.resolve(process.argv[2]), "utf8")
    : await new Promise((resolve, reject) => {
      let body = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { body += chunk; });
      process.stdin.on("end", () => resolve(body));
      process.stdin.on("error", reject);
    });
  const result = collaborationDecisionStructuralDiagnostic(JSON.parse(input));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.valid) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    scope: "structural-only",
    valid: false,
    errors: [error instanceof Error ? error.message : String(error)],
    diagnostic: hostText("skillScripts.orchestrator.structuralDiagnostic"),
  })}\n`);
  process.exitCode = 1;
}
