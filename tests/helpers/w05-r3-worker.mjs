import { SessionMessageStore } from '../../mcp-server/src/session-message-store.ts';
import { verifyHistoricalWakeObservation } from '../../mcp-server/src/session-message-wake-port.ts';

// Independent SQLite connection; the parent releases both workers after their ready receipts.
const store = new SessionMessageStore(process.argv[2]);
process.send({ ready: true });
process.once('message', input => {
  try {
    const result = input.operation === 'history'
      ? store.reconcileHistoricalWake(input.target, input.attemptId, input.sourceReceiptId, input.now,
        (...args) => verifyHistoricalWakeObservation(...args, input.trustPath))
      : store.submitPrepared(input.sender, input.messageId, input.now);
    store.close();
    // Simulate a committed result whose return never reaches the sender.
    if (input.loseReturn) process.exit(0);
    process.send({ result }, () => process.exit(0));
  } catch (error) {
    store.close();
    process.send({ error: error.message }, () => process.exit(1));
  }
});
