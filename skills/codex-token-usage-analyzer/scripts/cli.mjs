#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

import { analyzeRequest, canonicalJson, codexPaths, digest, isPortableAbsolute, writeNewMarkdown } from "./core.mjs";
import { contractErrors, validateProviderResult, validateReport, validateRequest } from "./schema-validation.mjs";

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) throw new Error("stdin에 TokenUsageReportRequest.v1 JSON이 필요합니다.");
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(`요청 JSON을 해석할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function adapterError(message, details = null) {
  return {
    schemaVersion: "1.0.0",
    kind: "adapter-error",
    output: null,
    artifacts: [],
    error: { code: "INVALID_INPUT", message, details }
  };
}

function errorFor(report) {
  if (report.verdict === "NEEDS_INPUT") return { code: "RUN_NOT_FOUND", message: report.message, details: { target: report.target.label } };
  if (report.verdict === "BLOCKED") return { code: "MISSING_EVIDENCE", message: report.message, details: { target: report.target.label } };
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
  if (!validateRequest(request)) return { result: adapterError(`TokenUsageReportRequest.v1 계약 위반: ${contractErrors(validateRequest).join("; ")}`), exitCode: 2 };
  if (request.markdown && !isPortableAbsolute(request.markdown.directory)) return { result: adapterError("Markdown 저장 디렉터리는 절대 경로여야 합니다."), exitCode: 2 };

  const locations = options.locations ?? codexPaths(options.environment);
  let report = await analyzeRequest(request, { ...options, locations });
  if (request.markdown && ["PASS", "PARTIAL"].includes(report.verdict)) {
    try {
      const pluginRoot = options.pluginRoot ?? path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
      report.markdownArtifact = await writeNewMarkdown(report, request.markdown.directory, { sessionsRoot: locations.sessionsRoot, pluginRoot, stamp: options.stamp });
    } catch (error) {
      report = { ...report, verdict: "BLOCKED", message: `Markdown을 저장할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`, markdownArtifact: null };
    }
  }
  if (!validateReport(report)) return { result: adapterError(`TokenUsageReport.v1 계약 위반: ${contractErrors(validateReport).join("; ")}`), exitCode: 2 };
  const result = providerResult(report, request.target);
  if (!validateProviderResult(result)) return { result: adapterError(`ProviderResult.v1 계약 위반: ${contractErrors(validateProviderResult).join("; ")}`), exitCode: 2 };
  return { result, exitCode: ["PASS", "PARTIAL"].includes(report.verdict) ? 0 : 1 };
}

async function main() {
  let result;
  let exitCode = 2;
  try {
    if (process.argv.length !== 2) throw new Error("CLI 인자는 허용되지 않습니다. 요청 JSON을 stdin으로 전달하세요.");
    ({ result, exitCode } = await execute(await readStdin()));
  } catch (error) {
    result = adapterError(error instanceof Error ? error.message : String(error));
  }
  process.stdout.write(`${canonicalJson(result)}\n`);
  process.exitCode = exitCode;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
