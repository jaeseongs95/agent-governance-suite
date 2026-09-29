// Writes meta.json for the v2.7.7 audit evidence. Args: <audit dir> <start stamp> <redaction counts JSON>
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const [d, start, red] = process.argv.slice(2);
const meta = { audit: "AGS 2.7.7 independent pre-release audit (byte-level session message line reader)",
  candidate: { branch: "claude/v277-utf8-framing", commit: "fd3f486a4ad976756532d1de0705e8a819f92778", tree: "1933de6506562af9dda1f4982fcbc24cc370952b",
    commits: ["bd571c7c fix: decode session message frames once per line in bytes", "cf09ff6a docs: describe byte-level session message framing for 2.7.7", "fd3f486a chore: release 2.7.7"] },
  baseline: { ref: "main (v2.7.6 + README PR #21)", commit: "9e76a07b81c8c8eba855acf48b7b25bf395e7548" },
  writerEvidenceReadForComparisonOnly: "evidence @ 26ba523 : v277-utf8/20260929T052434Z (SHA256SUMS 41/41)",
  previousBrokers: { "v2.7.6": "tag dist (bytes identical to v2.7.5)", "v2.7.5": "tag dist", "v2.7.3": "tag dist" },
  node: process.version, pnpm: execSync("pnpm --version").toString().trim(), uname: execSync("uname -r").toString().trim(),
  startedAtUtc: start, finishedAtUtc: new Date().toISOString(), verdict: "PASS_WITH_FINDINGS", releaseBlocking: false,
  findings: ["D-1 minor docs: release notes say the hook path (1 message, body <= 4096 bytes) could not reach 16384 bytes; a control-character-heavy body within 4096 bytes escapes past 16384 and was corrupted on 9e76a07b (3/3 layouts), intact on fd3f486a"],
  info: ["I-1 no test binds bytes after the newline (A1/A5/A6) or raw counting of invalid UTF-8 (A4); equivalent in current one-line-per-connection use, fuzz 20000 clean",
    "I-2 Buffer.concat per chunk: 1-byte chunks 179 ms vs old 111 ms per 32 KB line; 16 KB chunks 0.07 vs 0.21 ms",
    "I-3 over-limit close relies on write-after-end error then destroy, same as before; 64 MiB flood closed in about 9 ms, memory flat",
    "I-4 v2.7.6 and v2.7.5 broker bundles are byte-identical",
    "I-5 source broker 5 s ready wait x7 is the weak point on slow Windows runners",
    "I-6 pre-existing: claimResponseBytes counts {messages}; claim-wake/claim-host-wake add fields, unreachable with the bundled 1-message hook claims"],
  notRun: ["Windows run and GitHub CI for fd3f486a", "real PC, install cache, MCP call flow", "previous-broker v2.7.4, v2.7.2 and older", "source:verify", "D-1 through the real claim-host-wake hook path"],
  redaction: JSON.parse(red), redactionNote: "applied before the first commit; harness scripts carry redacted paths and are kept for reading" };
writeFileSync(`${d}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`);
