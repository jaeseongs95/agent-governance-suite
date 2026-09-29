// Audit-only preload: simulate a slow runner by making the broker process see the wall clock AGS_AUDIT_CLOCK_SHIFT_MS later.
// Only the broker (argv mentions session-message-broker) is shifted; the test process and client keep the real clock.
const shift = Number(process.env.AGS_AUDIT_CLOCK_SHIFT_MS ?? "0");
if (shift && process.argv.some((arg) => arg.includes("session-message-broker"))) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class ShiftedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(realNow() + shift); else super(...args); }
    static now() { return realNow() + shift; }
  }
  globalThis.Date = ShiftedDate;
  process.stderr.write(`[audit clockshift] broker pid ${process.pid} shifted +${shift}ms\n`);
}
