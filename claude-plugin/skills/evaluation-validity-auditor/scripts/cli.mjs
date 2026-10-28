#!/usr/bin/env node
import { analyzeEvaluation, InputError } from "./core.mjs";
import { argumentValue, readJsonInput, renderReportKo, writeJson } from "./io.mjs";

let format = "json";
try {
  const args = process.argv.slice(2);
  format = argumentValue(args, "--format") ?? "json";
  if (!["json", "human-ko"].includes(format)) throw new InputError("--format must be json or human-ko.");
  const input = await readJsonInput(args);
  const artifactRoot = argumentValue(args, "--artifact-root");
  if (!artifactRoot) throw new InputError("--artifact-root is required.");
  const report = await analyzeEvaluation(input, { artifactRoot });
  if (format === "human-ko") process.stdout.write(renderReportKo(report));
  else writeJson(report);
} catch (error) {
  const ioCode = !(error instanceof InputError) && !(error instanceof SyntaxError) && typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
  if (format === "human-ko") {
    process.stdout.write(
      ioCode
        ? `결론: 입출력 오류 (${ioCode}). 요청 파일 또는 증거 root 접근을 확인하세요. 평가 결과는 판정하지 않았습니다.\n`
        : "결론: 입력 오류 (INVALID_INPUT). 요청 형식과 증거 root를 확인하세요. 평가 결과는 판정하지 않았습니다.\n",
    );
  } else {
    writeJson({
      schemaVersion: "1.0.0",
      ok: false,
      error: {
        code: ioCode ?? "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
        details: ioCode ? { causeCategory: "io", causeCode: ioCode } : (error instanceof InputError ? error.details : null),
      },
    });
  }
  process.exitCode = 2;
}
