import { expect, it } from "vitest";
import { resolveHookHost } from "../../mcp-server/src/host-input-adapter.js";

it("keeps hook host identity opaque instead of requiring a fixed vendor name", () => {
  expect(resolveHookHost(["--host", "synthetic-host"], "codex")).toBe("synthetic-host");
  expect(resolveHookHost(["--host=provider.next:local"], "codex")).toBe("provider.next:local");
  expect(resolveHookHost([], "custom-default")).toBe("custom-default");
});

it.each([["--host", ""], ["--host", "../escape"], ["--host=first", "--host=second"]].map(args => [args] as const))("rejects malformed or ambiguous host entry arguments: %j", (args) => {
  expect(() => resolveHookHost(args, "codex")).toThrow();
});
