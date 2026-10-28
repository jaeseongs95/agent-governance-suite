import { expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ digest: "sha256:" + "a".repeat(64), request: vi.fn() }));
vi.mock("../../mcp-server/src/relay-code-identity.js", () => ({readRelayCodeDigest: () => f.digest}));
vi.mock("../../mcp-server/src/session-message-client.js", () => ({sessionMessageRequest: f.request}));
vi.mock("../../mcp-server/src/process-identity.js", () => ({processIdentityState: () => "match", processExists: () => false}));
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";

it("reports the startup snapshot even when installed code changes before acquire or a later invocation", async () => {
  f.digest = "sha256:" + "b".repeat(64);
  f.request.mockResolvedValue({acquired: true});
  const options = {host: "portable", sessionId: "startup", instanceId: "fixture", transport: "portable-queue", parentPid: 100, parentStartToken: "T1"};
  const port = {capabilities: {supportedInjection: [], idleWake: "none" as const}, dispatch: vi.fn()};
  await runSessionMessageRelay(options, port);
  await runSessionMessageRelay(options, port);
  const acquisitions = f.request.mock.calls.filter(([operation]) => operation === "acquire-relay");
  expect(acquisitions).toHaveLength(2);
  for (const [, payload] of acquisitions) expect(payload.codeDigest).toBe("sha256:" + "a".repeat(64));
});
