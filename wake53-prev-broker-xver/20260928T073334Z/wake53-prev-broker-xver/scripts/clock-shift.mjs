// Test-harness preload: shifts wall clock of this process by AGS_CLOCK_OFFSET_MS. No product source is modified.
const off = Number(process.env.AGS_CLOCK_OFFSET_MS || 0);
const RealDate = Date; const realNow = RealDate.now.bind(RealDate);
class ShiftedDate extends RealDate { constructor(...a) { if (a.length === 0) super(realNow() + off); else super(...a); } static now() { return realNow() + off; } }
globalThis.Date = ShiftedDate;
