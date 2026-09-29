// Writes meta.json for the v2.7.7 D-1 re-audit evidence. Args: <audit dir> <start stamp> <redaction counts JSON>
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const [d, start, red] = process.argv.slice(2);
writeFileSync(`${d}/meta.json`, `${JSON.stringify({
  audit: "AGS 2.7.7 re-audit of the D-1 documentation fix",
  candidate: { branch: "claude/v277-utf8-framing", commit: "00b16e845ec02a94d9d6be7877f62987687e80c7", tree: "e36595c3b9caaaeed89f3bf30b94d4fa0573e36c",
    commits: ["00b16e84 docs: correct the hook path exposure in the 2.7.7 notes"] },
  previousAudit: { target: "fd3f486a4ad976756532d1de0705e8a819f92778", evidence: "v277-audit/20260929T055100Z", verdict: "PASS_WITH_FINDINGS" },
  writerEvidenceReadForReferenceOnly: "v277-utf8-fix1/20260929T061611Z",
  node: process.version, pnpm: execSync("pnpm --version").toString().trim(), uname: execSync("uname -r").toString().trim(),
  startedAtUtc: start, finishedAtUtc: new Date().toISOString(), verdict: "PASS", releaseBlocking: false, findings: [],
  notes: ["\\b \\t \\n \\f \\r escape to 2 bytes; the sentence names \\u0001 as the 6-byte example, so not an error"],
  notRun: ["full test, runtime:check, validate:official (docs-only change; full run done at fd3f486a)", "Windows, CI, real PC and install cache, source:verify", "D-1 through the real claim-host-wake hook call"],
  redaction: JSON.parse(red), redactionNote: "applied before the first commit" }, null, 2)}\n`);
