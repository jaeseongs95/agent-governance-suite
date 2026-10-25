import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const entry = path.join(repository, "scripts/verify-korean-prose-evaluation-preflight.ts");
const directories: string[] = [];
const frameDigest = `sha256:${"a".repeat(64)}`;
const validityDigest = `sha256:${"b".repeat(64)}`;
type Route = "legacy" | "structured";

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ags-d0119-cli-"));
  directories.push(root);
  return root;
}

function cli(root: string, route: Route, preload?: string) {
  const options = ["--no-warnings", "--import", "tsx"];
  if (preload) options.push("--import", pathToFileURL(preload).href);
  const args = [entry, "selection", "1", root];
  if (route === "structured") args.push("--cycle-dir", path.join(root, "cycle"),
    "--expected-frame-digest", frameDigest, "--expected-validity-report-digest", validityDigest);
  return spawnSync(process.execPath, [...options, ...args], {
    cwd: repository, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
}

function failureJson(result: ReturnType<typeof cli>) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  // Parse the complete real child stderr: a raw rethrow/stack or second diagnostic fails here.
  const diagnostic = JSON.parse(result.stderr) as Record<string, unknown>;
  expect(diagnostic.status).toBe("failed");
  expect(result.stderr).not.toContain("SYNTHETIC_STACK_MUST_NOT_ESCAPE");
  expect(result.stderr).not.toContain("SYNTHETIC_EXTRA_MUST_NOT_ESCAPE");
  return diagnostic;
}

async function ioFault(root: string, route: Route, code: string, circular = false) {
  const target = route === "legacy" ? path.join(root, "evals/runs/manifest.json") : path.join(root, "cycle");
  const preload = path.join(root, "io-fault.mjs");
  // Only one exact synthetic filesystem operation is replaced in this child.
  // The real preflight producer, terminal catch, console serialization and process exit run unchanged.
  await writeFile(preload, `
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const target = ${JSON.stringify(target)};
const operation = ${JSON.stringify(route === "legacy" ? "readFile" : "realpath")};
const original = fs[operation];
fs[operation] = async function (file, ...args) {
  if (file !== target) return original.call(this, file, ...args);
  const cause = Object.assign(new Error("synthetic underlying I/O failure"), {
    code: "EIO", errno: -5, syscall: "open", path: "synthetic-cause",
  });
  const error = Object.assign(new Error("synthetic primary I/O failure", { cause }), {
    code: ${JSON.stringify(code)}, errno: ${code === "EACCES" ? -13 : -5},
    syscall: operation === "readFile" ? "open" : "realpath", path: target, dest: "synthetic-destination",
    extra: "SYNTHETIC_EXTRA_MUST_NOT_ESCAPE",
  });
  error.stack = cause.stack = "SYNTHETIC_STACK_MUST_NOT_ESCAPE";
  if (${JSON.stringify(circular)}) cause.cause = error;
  throw error;
};
syncBuiltinESMExports();
`, "utf8");
  return { preload, target };
}

it.each([
  ["legacy", "EACCES"], ["legacy", "EIO"],
  ["structured", "EACCES"], ["structured", "EIO"],
] as const)("actual %s CLI preserves %s code, errno, operation and cause in child stderr JSON", async (route, code) => {
  const root = await fixture();
  const { preload, target } = await ioFault(root, route, code);
  const diagnostic = failureJson(cli(root, route, preload));
  expect(diagnostic).toEqual({
    status: "failed", code, message: "synthetic primary I/O failure",
    details: {
      name: "Error", message: "synthetic primary I/O failure", code,
      errno: code === "EACCES" ? -13 : -5,
      syscall: route === "legacy" ? "open" : "realpath", path: target, dest: "synthetic-destination",
      causes: [{ name: "Error", message: "synthetic underlying I/O failure", code: "EIO", errno: -5, syscall: "open", path: "synthetic-cause" }],
    },
  });
});

it.each(["legacy", "structured"] as const)("keeps actual %s ENOENT as the existing readiness rejection", async route => {
  const root = await fixture();
  const diagnostic = failureJson(cli(root, route));
  expect(diagnostic).toMatchObject({ status: "failed", code: "READINESS_GATE_FAILED", details: null });
  expect(diagnostic.message).toContain("ENOENT");
});

it("keeps an actual incomplete structured frame as an ordinary readiness rejection", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "cycle"));
  await writeFile(path.join(root, "cycle/evaluation-frame.json"), "{}\n", "utf8");
  const diagnostic = failureJson(cli(root, "structured"));
  expect(diagnostic).toMatchObject({ status: "failed", code: "READINESS_GATE_FAILED", details: null });
  expect(diagnostic.message).toContain("evaluation frame does not satisfy its contract");
});

it("preserves the actual EvaluationPreflightError JSON contract", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "evals/runs"), { recursive: true });
  await writeFile(path.join(root, "evals/runs/manifest.json"), "{}\n", "utf8");
  expect(failureJson(cli(root, "legacy"))).toEqual({
    status: "failed", code: "DIGEST_MISMATCH",
    message: "DIGEST_MISMATCH: evaluation manifest is missing frozen run metadata", details: {},
  });
});

it("keeps actual malformed JSON distinct from a filesystem I/O failure", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "evals/runs"), { recursive: true });
  const manifest = path.join(root, "evals/runs/manifest.json");
  await writeFile(manifest, "{ not json", "utf8");
  const diagnostic = failureJson(cli(root, "legacy"));
  expect(diagnostic).toMatchObject({ status: "failed", code: "INVALID_JSONL", details: { file: manifest, reason: expect.any(String) } });
});

it("keeps circular I/O cause metadata bounded and JSON-safe at the terminal entry", async () => {
  const root = await fixture();
  const { preload } = await ioFault(root, "legacy", "EIO", true);
  const diagnostic = failureJson(cli(root, "legacy", preload));
  expect(diagnostic).toMatchObject({ code: "EIO", details: { causes: [
    { code: "EIO", errno: -5, syscall: "open", path: "synthetic-cause" }, { circular: true },
  ] } });
});
