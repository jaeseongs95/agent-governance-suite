#!/usr/bin/env node
import { argumentValue, readJsonFile, readJsonInput, renderReportKo, writeJson } from "./io.mjs";
import { validateReport } from "./core.mjs";

let format = "json";
try {
  const args = process.argv.slice(2);
  format = argumentValue(args, "--format") ?? "json";
  if (!["json", "human-ko"].includes(format)) throw new Error("--format must be json or human-ko.");
  const artifactRoot = argumentValue(args, "--artifact-root");
  if (!artifactRoot) throw new Error("--artifact-root is required.");
  const explicit = args.some((arg) => ["--request", "--request-artifact", "--report"].includes(arg));
  const validation = explicit
    ? {
      schemaVersion: "1.0.0",
      request: await readJsonFile(args, "--request"),
      requestArtifact: await readJsonFile(args, "--request-artifact"),
      report: await readJsonFile(args, "--report"),
    }
    : await readJsonInput(args);
  const errors = await validateReport(validation, { artifactRoot });
  if (format === "human-ko") {
    process.stdout.write(errors.length === 0
      ? `보고서 검증: 통과. 현재 요청·증거와 기계 보고서가 일치합니다.\n${renderReportKo(validation.report)}`
      : `보고서 검증: 실패. 불일치 ${errors.length}건입니다. 이 보고서의 결론을 사용할 수 없습니다. JSON 모드에서 검증 오류를 확인하세요.\n`);
  } else writeJson({ schemaVersion: "1.0.0", valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  if (format === "human-ko") process.stdout.write("보고서 검증: 입력 오류. 요청 형식과 증거 root를 확인하세요. 보고서의 유효성을 판정하지 않았습니다.\n");
  else writeJson({ schemaVersion: "1.0.0", valid: false, errors: [error instanceof Error ? error.message : String(error)] });
  process.exitCode = 2;
}
