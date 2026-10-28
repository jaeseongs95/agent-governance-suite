import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({read: vi.fn(), write: vi.fn()}));
vi.mock("node:fs", async original => ({...await original<typeof import("node:fs")>(), readFileSync: f.read, writeSync: f.write}));
import { readRelayCodeDigest, relayCodeDigest } from "../../mcp-server/src/relay-code-identity.js";

const entry = new URL("file:///private/entry-secret.mjs");
beforeEach(() => { f.read.mockReset(); f.write.mockReset(); });
afterEach(() => vi.restoreAllMocks());

it.each(["ENOENT", "EACCES", "EPERM", "EBUSY", "EIO"])("keeps %s entry-read failure advisory and emits only bounded cause metadata", code => {
  f.read.mockImplementation(() => { throw Object.assign(new Error("message-secret /private/file"), {code, path: "/private/path-secret"}); });
  expect(readRelayCodeDigest(entry)).toBeNull();
  expect(f.write).toHaveBeenCalledTimes(1);
  const [, serialized] = f.write.mock.calls[0]!;
  expect(serialized).not.toMatch(/message-secret|path-secret|entry-secret|\/private/);
  const diagnostic = JSON.parse(serialized.slice(serialized.indexOf("{")).trim());
  expect(diagnostic.reason).toBe("RELAY_CODE_READ_FAILED");
  expect(diagnostic.context.type).toBe("error");
  expect(diagnostic.context.code.prefixSha256).toBe(createHash("sha256").update(Buffer.from(code, "utf16le")).digest("hex"));
});

it("cannot turn a read failure into a relay failure when the diagnostic sink also fails", () => {
  f.read.mockImplementation(() => { throw new TypeError("read-secret"); });
  f.write.mockImplementation(() => { throw new Error("sink-secret"); });
  expect(readRelayCodeDigest(entry)).toBeNull();
  expect(f.write).toHaveBeenCalledTimes(1);
});

it("does not invoke an error code accessor or expose an unknown code string", () => {
  const getter = vi.fn(() => { throw new Error("getter-secret"); });
  const error = Object.defineProperty(new Error("message-secret"), "code", {get: getter});
  f.read.mockImplementation(() => { throw error; });
  expect(readRelayCodeDigest(entry)).toBeNull();
  expect(getter).not.toHaveBeenCalled();
  expect(f.write.mock.calls[0]![1]).not.toMatch(/getter-secret|message-secret/);
});

it("continues to reject malformed digest input rather than treating it as a read failure", () => {
  expect(() => relayCodeDigest("invalid-secret")).toThrow("Invalid relay code digest.");
  expect(f.write).not.toHaveBeenCalled();
});
