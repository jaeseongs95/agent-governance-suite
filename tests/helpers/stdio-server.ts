import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, beforeEach, it } from "vitest";

export interface StdioServer {
  client: Client;
  /** Everything the server wrote to stderr so far. */
  stderr(): string;
  /** Idempotent; also ends the child process. */
  close(): Promise<void>;
}

export type StdioServerParametersWithoutStderr = Omit<StdioServerParameters, "stderr">;
/** Receives the server's stderr stream before the handshake starts (for startup tracing). */
export type StderrObserver = (stream: StdioClientTransport["stderr"]) => void;

/**
 * What a start step gets. `connect` starts a server and completes the initialize handshake; it refuses once the start
 * step has ended, so a test body cannot start a server inside its own time limit by accident. A restart that is itself
 * the behavior under test uses `restartInTest`, which says so at the call site.
 */
export interface StdioStart {
  /** Registers a cleanup that runs after the test (or the suite, for a shared server), last first. */
  defer(cleanup: () => unknown): void;
  connect(clientName: string, parameters: StdioServerParametersWithoutStderr, observeStderr?: StderrObserver): Promise<StdioServer>;
  restartInTest(clientName: string, parameters: StdioServerParametersWithoutStderr, observeStderr?: StderrObserver): Promise<StdioServer>;
}

async function connectStdioServer(clientName: string, parameters: StdioServerParametersWithoutStderr, observeStderr?: StderrObserver): Promise<StdioServer> {
  const transport = new StdioClientTransport({ ...parameters, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  observeStderr?.(transport.stderr);
  const client = new Client({ name: clientName, version: "1.0.0" });
  let closed: Promise<void> | undefined;
  const close = () => closed ??= client.close();
  try { await client.connect(transport); } catch (error) { await close(); throw error; }
  return { client, stderr: () => stderr, close };
}

function startScope(deferred: Array<() => unknown>): { scope: StdioStart; end(): void } {
  let open = true;
  const tracked = async (clientName: string, parameters: StdioServerParametersWithoutStderr, observeStderr?: StderrObserver) => {
    const server = await connectStdioServer(clientName, parameters, observeStderr);
    deferred.push(() => server.close());
    return server;
  };
  const scope: StdioStart = {
    defer: (cleanup) => { deferred.push(cleanup); },
    connect: (clientName, parameters, observeStderr) => {
      if (!open) {
        return Promise.reject(new Error("STDIO_SERVER_STARTED_IN_TEST: start the server in the start step (stdioServerTests) or name an intended restart with restartInTest."));
      }
      return tracked(clientName, parameters, observeStderr);
    },
    restartInTest: tracked,
  };
  return { scope, end: () => { open = false; } };
}

async function runCleanups(deferred: Array<() => unknown>): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of deferred.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw errors[0];
}

/**
 * Registers tests whose server is started before the test's own time limit starts. vitest arms a test's timeout when
 * its body is called, after the beforeEach hooks. The start runs in a beforeEach without a vitest timer (0), so a loaded
 * runner's process start, module load and initialize handshake no longer count against the assertions' limit. The start
 * is still bounded: by the SDK's initialize request timeout (60 s) and by the child's exit, which rejects the handshake.
 * Cleanups registered with `defer` (and every server the scope started) run after the test, last first.
 * An omitted timeout is the vitest default.
 */
export function stdioServerTests(): <T>(name: string, start: (scope: StdioStart) => Promise<T>,
  run: (started: T, scope: StdioStart) => Promise<void>, timeout?: number) => void {
  const starts = new Map<string, (scope: StdioStart) => Promise<unknown>>();
  const deferred: Array<() => unknown> = [];
  let current: { value: unknown; scope: StdioStart } | undefined;
  beforeEach(async ({ task }) => {
    const start = starts.get(task.name);
    if (!start) return;
    const { scope, end } = startScope(deferred);
    try { current = { value: await start(scope), scope }; } finally { end(); }
  }, 0);
  afterEach(async () => {
    current = undefined;
    await runCleanups(deferred);
  });
  return (name, start, run, timeout) => {
    starts.set(name, start);
    it(name, () => run(current!.value as Parameters<typeof run>[0], current!.scope), timeout);
  };
}

/** One server shared by every test of the enclosing suite, started in a beforeAll without a vitest timer (see above). */
export function stdioServerForSuite<T>(start: (scope: StdioStart) => Promise<T>): () => T {
  const deferred: Array<() => unknown> = [];
  let value: { started: T } | undefined;
  beforeAll(async () => {
    const { scope, end } = startScope(deferred);
    try { value = { started: await start(scope) }; } finally { end(); }
  }, 0);
  afterAll(async () => {
    value = undefined;
    await runCleanups(deferred);
  });
  return () => {
    if (!value) throw new Error("The suite's STDIO server did not start.");
    return value.started;
  };
}
