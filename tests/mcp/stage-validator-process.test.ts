import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowContractError } from "../../contracts/types.js";
import { render } from "../../mcp-server/src/i18n.js";
import { runStageValidator } from "../../mcp-server/src/stage-validator-process.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function child(report: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-validator-"));
  directories.push(directory);
  const script = path.join(directory, "child.mjs");
  await writeFile(script, `console.error(${JSON.stringify(JSON.stringify(report))}); process.exitCode = 2;\n`);
  return script;
}

function failure(script: string): WorkflowContractError {
  try {
    runStageValidator("Engineering stage", script, [], [0]);
  } catch (error) {
    if (error instanceof WorkflowContractError) return error;
    throw error;
  }
  throw new Error("validator did not fail");
}

describe("stage validator child failures (docs/contributing/i18n.md 6)", () => {
  it("nests a child's catalog key so the reader's locale renders it", async () => {
    const error = failure(await child({ status: "ERROR", code: "IO_ERROR", message: "호스트 문장", messageKey: "practices.cli.ioError", params: {} }));
    expect(render(error.ref, "en")).toBe("Could not read or execute the explicitly requested local input.");
    expect(render(error.ref, "ko")).toBe("명시적으로 요청한 로컬 입력을 읽거나 실행하지 못했다.");
  });

  it("keeps the child's own sentence when its key is unknown to this catalog", async () => {
    const error = failure(await child({ code: "IO_ERROR", message: "from a later version", messageKey: "practices.fromLaterVersion", params: {} }));
    expect(render(error.ref, "ko")).toBe("from a later version");
  });
});
