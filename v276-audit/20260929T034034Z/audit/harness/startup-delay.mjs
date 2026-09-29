// Audit-only preload: delays only the broker process's start by AGS_AUDIT_BROKER_STARTUP_DELAY_MS (a slow cold start).
if (process.argv.some((arg) => arg.includes("session-message-broker"))) {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.AGS_AUDIT_BROKER_STARTUP_DELAY_MS ?? "0")));
}
