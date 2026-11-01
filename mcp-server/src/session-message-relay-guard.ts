import { persistRelayFailure } from "./session-message-wake-port.js";

// D0011: the hook preloads this (--import) into the detached relay before the relay entry module loads. The hook may
// already have exited and the relay's stdio is ignored, so the relay process itself records an entry that fails to
// load, rejects its arguments or ends non-zero, with its exit code only. A signal death runs no exit handler.
process.once("exit", (exitCode) => {
  if (exitCode === 0) return;
  persistRelayFailure(JSON.stringify({ phase: "relay-exit", reason: "RELAY_PROCESS_EXITED", reasonBasis: "producer", exitCode }));
});
