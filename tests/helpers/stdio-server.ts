import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, it } from "vitest";

export interface StdioServer {
  client: Client;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  /** Idempotent; also ends the child process. */
  close(): Promise<void>;
}

/** Starts an MCP STDIO server and completes the initialize handshake. A failed start closes what it opened. */
export async function connectStdioServer(clientName: string, parameters: Omit<StdioServerParameters, "stderr">): Promise<StdioServer> {
  const transport = new StdioClientTransport({ ...parameters, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: clientName, version: "1.0.0" });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= client.close();
  try { await client.connect(transport); } catch (error) { await close(); throw error; }
  return { client, stderr: () => stderr, close };
}

/**
 * Registers tests whose server is started before the test's own time limit starts. vitest arms a test's timeout when
 * its body is called, after the beforeEach hooks. The start runs in a beforeEach without a vitest timer (0), so a loaded
 * runner's process start, module load and initialize handshake no longer count against the assertions' limit. The start
 * is still bounded: by the SDK's initialize request timeout (60 s) and by the child's exit, which rejects the handshake.
 * Call inside a describe; `defer` registers cleanups that run after the test, last first, whether it passed or not.
 */
export function stdioServerTests(): <T>(name: string, start: (defer: (cleanup: () => unknown) => void) => Promise<T>,
  run: (started: T) => Promise<void>, timeout?: number) => void {
  const starts = new Map<string, (defer: (cleanup: () => unknown) => void) => Promise<unknown>>();
  const deferred: Array<() => unknown> = [];
  let current: unknown;
  beforeEach(async ({ task }) => {
    const start = starts.get(task.name);
    if (start) current = await start((cleanup) => { deferred.push(cleanup); });
  }, 0);
  afterEach(async () => {
    current = undefined;
    const errors: unknown[] = [];
    for (const cleanup of deferred.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw errors[0];
  });
  return (name, start, run, timeout) => {
    starts.set(name, start);
    it(name, () => run(current as Parameters<typeof run>[0]), timeout);
  };
}
