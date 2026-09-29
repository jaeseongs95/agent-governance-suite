// Slow-runner simulation: only a process whose argv names session-message-broker sees the wall clock AGS_CLOCK_SHIFT_MS later.
// The test process and clients keep the real clock, as when seeding and broker start are slow.
const shift = Number(process.env.AGS_CLOCK_SHIFT_MS ?? "0");
if (shift && process.argv.some((arg) => arg.includes("session-message-broker"))) {
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  class ShiftedDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(realNow() + shift); else super(...args); }
    static now() { return realNow() + shift; }
  }
  globalThis.Date = ShiftedDate;
  process.stderr.write(`[clockshift] broker pid ${process.pid} shifted +${shift}ms\n`);
}
