import { afterEach, beforeEach, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({ exec: vi.fn(), asyncExec: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: ports.exec, execFile: ports.asyncExec }));
import { processStartToken, processStartTokenAsync } from "../../mcp-server/src/process-identity.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";

beforeEach(() => { ports.exec.mockReset();ports.asyncExec.mockReset(); });
afterEach(() => vi.restoreAllMocks());

it.each([
  ["ENOENT", null, null], ["EACCES", null, null], ["ETIMEDOUT", null, "SIGTERM"],
  [undefined, 1, null],
] as const)("retains original native failure %s/%s/%s while returning UNKNOWN and emitting no payload", (code, status, signal) => {
  const native = Object.assign(new Error("PRIVATE_MESSAGE"), { code, status, signal,
    stdout: "PRIVATE_BIRTH", stderr: Buffer.from("PRIVATE_KEY_AND_ENV PermissionDenied"), killed: signal !== null });
  ports.exec.mockImplementation(() => { throw native; });
  let now = 100;
  vi.spyOn(performance, "now").mockImplementation(() => now++);
  const output: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(value => { output.push(String(value)); return true; });
  const observations: Array<{ cause: unknown; diagnostic: unknown }> = [];
  expect(processStartToken(424242, "win32", 23, (cause, diagnostic) => observations.push({ cause, diagnostic }))).toBeNull();
  expect(observations).toHaveLength(1);
  expect(observations[0]!.cause).toBe(native);
  expect(observations[0]!.diagnostic).toMatchObject({ stage: "windows-query", elapsedMs: 1, timeoutMs: 23, nativeCode: code ?? null, status, signal });
  expect(output).toHaveLength(1);
  expect(output[0]!.length).toBeLessThan(1024);
  expect(output.join("")).not.toMatch(/PRIVATE_|424242|StartTime|GetProcessById/u);
  expect(output[0]).toContain('"stderrIndication":"permission-denied-indication"');
});

it("a failing diagnostic sink or observer never changes UNKNOWN or replaces the primary native error", () => {
  const native = Object.assign(new Error("PRIVATE_NATIVE"), { code: "ETIMEDOUT", signal: "SIGTERM", status: null });
  const sink = new Error("PRIVATE_SINK"), observer = new Error("PRIVATE_OBSERVER");
  ports.exec.mockImplementation(() => { throw native; });
  vi.spyOn(process.stderr, "write").mockImplementation(() => { throw sink; });
  expect(processStartToken(424242, "win32", 23, () => { throw observer; })).toBeNull();
  expect(failureContext(native)).toMatchObject({ producerReason: "PROCESS_START_TOKEN_FAILED", secondary: [{ type: "error" }, { type: "error" }] });
});

it("preserves invalid/exhausted input rejection without launching a process", () => {
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(processStartToken(424242, "win32", timeout)).toBeNull();
  expect(processStartToken(-1, "win32", 20)).toBeNull();
  expect(ports.exec).not.toHaveBeenCalled();
});

it.each([1,"ABORT_ERR"] as const)("retains asynchronous native failure %s and classifies its separate bounded stderr callback",async code=>{
  const native=Object.assign(new Error("PRIVATE_ASYNC_ERROR"),{code,signal:code===1?null:"SIGTERM"});
  const controller=new AbortController(),observations:Array<{cause:unknown;diagnostic:unknown}>=[],output:string[]=[];
  ports.asyncExec.mockImplementation((_exe,_args,options,callback)=>{
    expect(options).toMatchObject({timeout:23,maxBuffer:4096,signal:controller.signal});
    callback(native,"PRIVATE_BIRTH","PRIVATE_KEY PermissionDenied");
  });
  vi.spyOn(process.stderr,"write").mockImplementation(value=>{output.push(String(value));return true;});
  await expect(processStartTokenAsync(424242,"win32",23,(cause,diagnostic)=>observations.push({cause,diagnostic}),controller.signal)).resolves.toBeNull();
  expect(observations).toHaveLength(1);
  expect(observations[0]!.cause).toBe(native);
  expect(observations[0]!.diagnostic).toMatchObject({nativeCode:code===1?null:code,status:code===1?1:null,stderrIndication:"permission-denied-indication"});
  expect(output.join("")).not.toMatch(/PRIVATE_|424242|GetProcessById/u);
});
