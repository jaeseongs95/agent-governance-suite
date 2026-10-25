import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  open: vi.fn(), exec: vi.fn(), prepare: vi.fn(), close: vi.fn(),
  readFile: vi.fn(), mkdir: vi.fn(), mkdtemp: vi.fn(), rename: vi.fn(),
  copyFile: vi.fn(), rm: vi.fn(), rmdir: vi.fn(), lstat: vi.fn(),
  write: vi.fn<(fd: number, data: unknown) => number>(() => 0),
}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class {
    constructor(file: string, options?: { readOnly?: boolean }) { ports.open(file, options); }
    exec(sql: string) { return ports.exec(sql); }
    prepare(sql: string) { return ports.prepare(sql); }
    close() { return ports.close(); }
  },
}));
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(), writeSync: ports.write,
}));
vi.mock("node:fs/promises", async original => ({
  ...await original<typeof import("node:fs/promises")>(),
  readFile: ports.readFile, mkdir: ports.mkdir, mkdtemp: ports.mkdtemp,
  rename: ports.rename, copyFile: ports.copyFile, rm: ports.rm,
  rmdir: ports.rmdir, lstat: ports.lstat,
}));

const initialArgv = process.argv;
const initialExitCode = process.exitCode;
let stdout: ReturnType<typeof vi.spyOn>;
const privateError = (marker: string, errcode = 1) =>
  Object.freeze(Object.assign(new Error(marker), { code: "ERR_SQLITE_ERROR", errcode }));
const emptyDigest = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

beforeEach(() => {
  vi.resetModules();
  for (const port of Object.values(ports)) port.mockReset();
  ports.readFile.mockResolvedValue("");
  ports.mkdir.mockResolvedValue(undefined);
  ports.mkdtemp.mockResolvedValue("synthetic-private-transaction");
  ports.rename.mockResolvedValue(undefined);
  ports.copyFile.mockResolvedValue(undefined);
  ports.rm.mockResolvedValue(undefined);
  ports.rmdir.mockResolvedValue(undefined);
  ports.lstat.mockResolvedValue({ isFile: () => true });
  ports.write.mockImplementation((_fd: number, data: unknown) =>
    Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8"));
  ports.prepare.mockImplementation((sql: string) => ({
    run: vi.fn(), get: () => ({ integrity_check: "ok" }),
    all: () => sql === "SELECT key, value FROM metadata ORDER BY key"
      ? [{ key: "schemaVersion", value: "1.0.0" }, { key: "glossaryId", value: "synthetic-glossary" },
        { key: "glossaryVersion", value: "fixture-v1" }, { key: "contentDigest", value: emptyDigest }] : [],
  }));
  stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  process.exitCode = undefined;
});
afterEach(() => {
  process.argv = initialArgv;
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
});

async function cli(mode = "check") {
  process.argv = ["node", "korean-prose-glossary.ts", "--mode", mode,
    "--seed", "synthetic-private-seed", "--db", "synthetic-private-database"];
  // Execute the actual terminal entry and actual library/recovery code. Only I/O ports are controlled.
  await import("../../scripts/korean-prose-glossary.js");
}
function diagnostic(attemptedOutput = false) {
  expect(ports.write).toHaveBeenCalledTimes(attemptedOutput ? 2 : 1);
  const records = ports.write.mock.calls.filter(call => call[0] === 2);
  expect(records).toHaveLength(1);
  const text = String(records[0]![1]);
  expect(text.trim().split(/\r?\n/u)).toHaveLength(1);
  for (const secret of ["PRIVATE_", "synthetic-private", "Error:", "at "]) expect(text).not.toContain(secret);
  expect(stdout).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  return JSON.parse(text);
}

it("actual check CLI consumes load and close errors once without an uncaught rethrow", async () => {
  ports.exec.mockImplementationOnce(() => { throw privateError("PRIVATE_QUERY", 11); });
  ports.close.mockImplementationOnce(() => { throw privateError("PRIVATE_CLOSE", 21); });
  await expect(cli()).resolves.toBeUndefined();
  expect(diagnostic()).toMatchObject({
    component: "korean-prose-glossary", phase: "check", reason: "GLOSSARY_LOAD_FAILED",
    context: { producerReason: "GLOSSARY_LOAD_FAILED", sqlite: { errcode: 11 },
      secondary: [{ producerReason: "GLOSSARY_CLOSE_FAILED", sqlite: { errcode: 21 } }] },
  });
  expect(ports.close).toHaveBeenCalledTimes(1);
});

it("actual check CLI distinguishes reviewed seed mismatch from unavailable storage", async () => {
  ports.readFile.mockResolvedValue(JSON.stringify({
    entryId: "reviewed", canonicalForm: "검토", policy: "protect",
    sourceRef: "https://example.invalid/reviewed", priority: 1, active: true,
    forms: [{ form: "검토", kind: "canonical" }],
  }));
  await cli();
  expect(diagnostic()).toMatchObject({
    phase: "check", reason: "GLOSSARY_SEED_MISMATCH",
    context: { producerReason: "GLOSSARY_SEED_MISMATCH" },
  });
  expect(ports.close).toHaveBeenCalledTimes(1);
});

it("actual build CLI preserves primary, rollback, close, transaction cleanup and lock cleanup in one record", async () => {
  ports.exec.mockImplementation((sql: string) => {
    if (sql.startsWith("CREATE TABLE metadata")) throw privateError("PRIVATE_PRIMARY", 19);
    if (sql === "ROLLBACK;") throw privateError("PRIVATE_ROLLBACK", 1);
  });
  ports.close.mockImplementationOnce(() => { throw privateError("PRIVATE_CLOSE", 21); });
  ports.rm.mockRejectedValueOnce(privateError("PRIVATE_TRANSACTION", 10));
  ports.rmdir.mockRejectedValueOnce(privateError("PRIVATE_LOCK", 5));
  await expect(cli("build")).resolves.toBeUndefined();
  expect(diagnostic()).toMatchObject({
    phase: "build", reason: "GLOSSARY_BUILD_FAILED", recoveryReason: "GLOSSARY_BUILD_FAILED",
    context: { producerReason: "GLOSSARY_BUILD_FAILED", sqlite: { errcode: 19 }, secondary: [
      { producerReason: "GLOSSARY_ROLLBACK_FAILED", sqlite: { errcode: 1 } },
      { producerReason: "GLOSSARY_CLOSE_FAILED", sqlite: { errcode: 21 } },
    ] },
    secondary: [
      { producerReason: "GLOSSARY_TRANSACTION_CLEANUP_FAILED", sqlite: { errcode: 10 } },
      { producerReason: "GLOSSARY_LOCK_CLEANUP_FAILED", sqlite: { errcode: 5 } },
    ],
  });
  expect(ports.exec.mock.calls.filter(call => call[0] === "ROLLBACK;")).toHaveLength(1);
  expect(ports.close).toHaveBeenCalledTimes(1);
  expect(ports.rm).toHaveBeenCalledTimes(1);
  expect(ports.rmdir).toHaveBeenCalledTimes(1);
});

it("actual build CLI consumes a real failed restore and lock cleanup as separate bounded contexts", async () => {
  ports.rename.mockResolvedValueOnce(undefined).mockRejectedValueOnce(privateError("PRIVATE_PUBLISH", 10));
  ports.copyFile.mockRejectedValueOnce(privateError("PRIVATE_RESTORE", 14));
  ports.rmdir.mockRejectedValueOnce(privateError("PRIVATE_LOCK", 5));
  await cli("build");
  expect(diagnostic()).toMatchObject({
    phase: "build", recoveryReason: "GLOSSARY_BUILD_FAILED",
    context: { sqlite: { errcode: 10 } },
    secondary: [
      { producerReason: "GLOSSARY_RESTORE_FAILED", sqlite: { errcode: 14 } },
      { producerReason: "GLOSSARY_LOCK_CLEANUP_FAILED", sqlite: { errcode: 5 } },
    ],
  });
  expect(ports.copyFile).toHaveBeenCalledTimes(1);
  expect(ports.rm).not.toHaveBeenCalled(); // Validated unpublished recovery data remains.
  expect(ports.rmdir).toHaveBeenCalledTimes(1);
});

it("a failed final stderr sink leaves the real command failed and does not rethrow", async () => {
  ports.exec.mockImplementationOnce(() => { throw privateError("PRIVATE_PRIMARY", 11); });
  ports.write.mockImplementationOnce(() => { throw new Error("PRIVATE_SINK"); });
  await expect(cli()).resolves.toBeUndefined();
  expect(process.exitCode).toBe(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(ports.write).toHaveBeenCalledTimes(1);
  expect(ports.close).toHaveBeenCalledTimes(1);
});

it("normal actual CLI keeps the existing successful stdout and writes no failure diagnostic", async () => {
  await cli();
  expect(process.exitCode).toBeUndefined();
  expect(stdout).not.toHaveBeenCalled();
  expect(ports.write).toHaveBeenCalledTimes(1);
  expect(ports.write.mock.calls[0]![0]).toBe(1);
  expect(JSON.parse(String(ports.write.mock.calls[0]![1]))).toEqual({
    status: "ok", entries: 0, id: "synthetic-glossary", version: "fixture-v1", contentDigest: emptyDigest,
  });
});

it("a real stdout port failure reaches the final safe diagnostic without an uncaught stream error", async () => {
  ports.write.mockImplementation((fd: number) => {
    if (fd === 1) throw Object.assign(new Error("PRIVATE_STDOUT"), { code: "EPIPE" });
    return 0;
  });
  await expect(cli()).resolves.toBeUndefined();
  expect(diagnostic(true)).toMatchObject({ phase: "output", reason: "GLOSSARY_OUTPUT_FAILED", context: { type: "error" } });
  expect(ports.close).toHaveBeenCalledTimes(1);
});

it.each(["zero", "partial"])("short stdout write (%s) cannot report command success", async mode => {
  ports.write.mockImplementation((fd: number, data: unknown) => {
    const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
    return fd === 1 ? (mode === "zero" ? 0 : bytes - 1) : bytes;
  });
  await expect(cli()).resolves.toBeUndefined();
  expect(diagnostic(true)).toMatchObject({ phase: "output", reason: "GLOSSARY_OUTPUT_FAILED" });
  expect(ports.close).toHaveBeenCalledTimes(1);
});
