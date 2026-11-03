#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { hostText } from "../../../runtime/i18n.mjs";
import { analyzeRequest, canonicalJson, codexPaths, digest, getReportMeta, isPortableAbsolute, writeNewMarkdown } from "./core.mjs";
import { contractErrors, validateProviderResult, validateReport, validateRequest } from "./schema-validation.mjs";

async function readStdin(stream = process.stdin) {
  let input = "";
  stream.setEncoding?.("utf8");
  for await (const chunk of stream) input += chunk;
  if (!input.trim()) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.stdinRequired"));
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.requestParseFailed", { detail: error instanceof Error ? error.message : String(error) }));
  }
}

function adapterError(message, details = null, code = "INVALID_INPUT") {
  return {
    schemaVersion: "1.0.0",
    kind: "adapter-error",
    output: null,
    artifacts: [],
    error: { code, message, details }
  };
}

function errorFor(report) {
  const meta = getReportMeta(report);
  if (report.verdict === "NEEDS_INPUT") {
    const reason = meta?.reason ?? "not_found";
    const code = meta?.code ?? (reason === "not_found" ? "RUN_NOT_FOUND" : "INVALID_INPUT");
    return { code, message: report.message, details: { target: report.target.label, reason } };
  }
  if (report.verdict === "BLOCKED") {
    return {
      code: "MISSING_EVIDENCE",
      message: report.message,
      details: {
        target: report.target.label,
        ...(meta?.reason ? { reason: meta.reason } : {}),
        ...(meta?.causeCode ? { causeCode: meta.causeCode } : {})
      }
    };
  }
  return null;
}

function providerResult(report, target) {
  const targetDigest = digest(target);
  const artifacts = [{
    artifactId: "token-usage-report",
    schemaId: "TokenUsageReport.v1",
    locator: "stdout:#/output",
    digest: digest(report),
    targetDigest,
    verified: true
  }];
  if (report.markdownArtifact) artifacts.push({
    artifactId: "token-usage-markdown-artifact",
    schemaId: "text/markdown",
    locator: report.markdownArtifact.path,
    digest: report.markdownArtifact.digest,
    targetDigest,
    verified: true
  });
  return { schemaVersion: "1.0.0", kind: "output", output: report, artifacts, error: errorFor(report) };
}

export async function execute(request, options = {}) {
  if (!validateRequest(request)) return { result: adapterError(hostText("skillReportsKo.codexTokenUsageAnalyzer.requestContractViolation", { errors: contractErrors(validateRequest).join("; ") })), exitCode: 2 };
  if (request.markdown && !isPortableAbsolute(request.markdown.directory)) return { result: adapterError(hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownDirectoryNotAbsolute")), exitCode: 2 };

  const locations = options.locations ?? codexPaths(options.environment);
  let report = await analyzeRequest(request, { ...options, locations });
  if (request.markdown && ["PASS", "PARTIAL"].includes(report.verdict)) {
    try {
      const pluginRoot = options.pluginRoot ?? path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
      report.markdownArtifact = await writeNewMarkdown(report, request.markdown.directory, { sessionsRoot: locations.sessionsRoot, pluginRoot, stamp: options.stamp });
    } catch (error) {
      report = { ...report, verdict: "BLOCKED", message: hostText("skillReportsKo.codexTokenUsageAnalyzer.markdownSaveFailed", { detail: error instanceof Error ? error.message : String(error) }), markdownArtifact: null };
    }
  }
  if (!validateReport(report)) return { result: adapterError(hostText("skillReportsKo.codexTokenUsageAnalyzer.reportContractViolation", { errors: contractErrors(validateReport).join("; ") })), exitCode: 2 };
  const result = providerResult(report, request.target);
  if (!validateProviderResult(result)) return { result: adapterError(hostText("skillReportsKo.codexTokenUsageAnalyzer.providerResultContractViolation", { errors: contractErrors(validateProviderResult).join("; ") })), exitCode: 2 };
  return { result, exitCode: ["PASS", "PARTIAL"].includes(report.verdict) ? 0 : 1 };
}

export async function main(stdinStream = process.stdin, argv = process.argv) {
  let result;
  let exitCode = 2;
  try {
    if (argv.length !== 2) throw new Error(hostText("skillReportsKo.codexTokenUsageAnalyzer.cliArgumentsNotAllowed"));
    ({ result, exitCode } = await execute(await readStdin(stdinStream)));
  } catch (error) {
    const ioCode = !(error instanceof SyntaxError) && typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
    result = adapterError(
      error instanceof Error ? error.message : String(error),
      ioCode ? { causeCategory: "io", causeCode: ioCode } : null,
      ioCode ? "MISSING_EVIDENCE" : "INVALID_INPUT"
    );
  }
  process.stdout.write(`${canonicalJson(result)}\n`);
  process.exitCode = exitCode;
  return { result, exitCode };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
