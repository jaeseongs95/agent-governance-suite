// previousAtLeast from 906a023a tests/session-messaging/previous-broker.test.ts, copied verbatim (body) for boundary checks.
function make(previousVersion) { return function previousAtLeast(minimum) {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(previousVersion ?? "");
  if (!parts) throw new Error("Set AGS_PREVIOUS_BROKER_VERSION to the previous broker's release version (for example 2.7.5).");
  const version = parts.slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) if (version[index] !== minimum[index]) return version[index] > minimum[index];
  return true;
}; }
for (const v of [undefined, "", "2.7.5", "v2.7.5", "2.7.4", "2.7.10", "2.8.0", "3.0.0", "2.6.9", "1.99.99", "2.7.3", "2.7", "2.7.5-rc.1", " 2.7.5", "V2.7.5", "02.07.05"]) {
  let out; try { out = make(v)([2, 7, 5]); } catch (e) { out = "THROW"; }
  console.log(JSON.stringify(v), "->", out);
}
