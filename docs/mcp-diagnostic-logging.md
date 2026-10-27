# MCP diagnostic logging candidate

Status: per-instance candidate implementation for `release-3.0` source `77caba7ce53fc3ec12e1a25ff2d74015c5288626`. No installation or 2.9.0 runtime compatibility is claimed.

Set `AGENT_GOVERNANCE_LOG_CONFIG` to a JSON object, for example:

```json
{"level":"INFO","categories":{"request":"DEBUG","binding":"TRACE"},"destination":"stderr","format":"json","bufferBytes":65536,"rotationBytes":1048576,"rotationIntervalMs":1000,"retainedFiles":3,"flushDeadlineMs":100}
```

The default is OFF. Levels are TRACE, DEBUG, INFO, WARN, ERROR, FATAL, OFF. Categories are lifecycle, request, binding, transport. Category overrides replace the global threshold. File destination requires `file` (the base pathname); a generated instance suffix prevents concurrent processes from reopening each other's files. `retainedFiles` is the library's archived-file count, excluding the active file. Invalid configuration produces only a constant `LOG_CONFIG_INVALID` warning and continues service startup. Configuration values and parse exceptions are never logged. JSON is the currently supported format.

Pino 10.4.0 performs structured logging. SonicBoom 5.0.2 and pino-roll 4.0.0 provide asynchronous destination buffering and rotation. They run in a separate child process because an unread Windows stderr can leave an in-flight native write uncancellable even when SonicBoom is asynchronous or a worker thread is terminated. No direct library destination or synchronous fatal/exit flush runs in the MCP process.

The MCP process admits IPC records only within `bufferBytes`, including records awaiting child acknowledgement. The child acknowledges after submitting a record to its separate bounded destination. Thus destination bytes and outstanding IPC bytes have separate finite bounds; IPC credit is never returned merely because `send` called its callback. Logging applies drop-new on overflow; `droppedRecords`/`droppedBytes` count admission or destination drops. `unconfirmedRecords`/`unconfirmedBytes` count records whose handoff was still unacknowledged when the sink exited, failed or exceeded its shutdown deadline; these records might have been written just before acknowledgement was lost. `sinkErrors` and `shutdownLossPossible` report errors and uncertain sink-buffer loss, including records already acknowledged by the child but not confirmed flushed. Normal shutdown requires the library finish event and an explicit child `flushed` message; IPC acknowledgement alone is not a flush or durability guarantee. No caller waits for logging. Sink/open failures preserve the original MCP response or thrown error.

The `shutdown_start` event is a pre-flush snapshot, never final shutdown success. Final in-memory counters are available after `close()` resolves; the application currently does not persist a final settlement record, and forced termination can prevent all final reporting.

The parent permits at most `flushDeadlineMs` for shutdown, then force-terminates its sink child. Forced application termination can lose all buffered records. A disconnected sink child force-terminates itself. Logs are best-effort evidence, not an audit transaction; absence of a record does not prove an operation did not happen. The library's fatal method receives a write-only destination without a `flushSync` method.

Only registered tool names, internally generated correlation IDs, elapsed time, typed result/error codes, allowlisted proof rejection reasons/check names, and proof/binding existence are logged. A successfully completed root-proof verification is explicitly recorded; hook delivery and host application of updatedInput stay UNKNOWN. No arguments, response bodies, peer messages, arbitrary error messages, token/proof text, or native conversation data are serialized to the sink. Startup records identify the actual module URL and runtime file hash. SDK/protocol stdout is separate from diagnostics.

## Remaining acceptance gaps

- Every instance independently enforces `rotationBytes` on encoded UTF-8 lines. At that limit, or while the library is reopening a destination, it drops new records until a real destination `ready` event resets the byte count. `rotationIntervalMs` controls the library's periodic rotation, not a timer-based counter reset. Rotation/cleanup errors disable the sink and retain loss counters. Aggregate disk usage across concurrently running instances is not capped; no global quota or slot policy is implemented. The selected contract is per-instance bounds only.
- JSON formatting is implemented; a selectable text formatter is not implemented.
- `transport` has a category/configuration contract but sink failure/drop observations are currently reflected in counters on later records rather than separate durable transport events.
- The 2.9.0 hotfix, actual installed runtime, and production D0302 failure cause have not been validated. In 2.9.0, signature validity must remain UNKNOWN because that version does not perform the new root-proof verification.
- The added child-per-server resource cost and full Linux/Windows CI have not been measured. No production activation is implied by local tests.

## Reproducible checks

Run `node scripts/build.mjs` before tests that exercise bundled files. `tests/diagnostics/async-logging.test.ts` copies only two generated modules into a temporary directory without node_modules, then verifies category thresholds, redaction/FATAL, bounded IPC/drop behavior under unread stderr, file-open failure, library rotation/retention for a completed batch, sustained writes with a 1024-byte active-file limit, and a controlled failure to open the next rotated file. No aggregate/global disk bound is claimed. `tests/diagnostics/server-logging.test.ts` exercises actual MCP handler success, typed rejection and exception paths through an in-memory transport. Existing stdio and contract-error suites additionally check preserved behavior; they do not constitute saturated-stdio load proof.
