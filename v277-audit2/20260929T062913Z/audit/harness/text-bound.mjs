// Worst-case line sizes for one 4096-byte body without C0 control characters other than \b \t \n \f \r (each escapes to
// 2 bytes), with the longest identities the broker accepts (host 64, sessionId 200). Checks "일반 텍스트 본문이면 16384 byte에 닿지 않는다".
const id = { host: "h".repeat(64), sessionId: "s".repeat(200) };
const stamp = new Date().toISOString();
const bodies = { quotes: '"'.repeat(4096), backslashes: "\\".repeat(4096), newlines: "\n".repeat(4096), tabs: "\t".repeat(4096),
  loneSurrogates: "\ud800".repeat(1365), korean: "한".repeat(1365), control0x01_2401: "\u0001".repeat(2401) + "a".repeat(1695) };
const rows = {};
for (const [name, body] of Object.entries(bodies)) {
  const bodyBytes = Buffer.byteLength(body);
  const claim = Buffer.byteLength(JSON.stringify({ ok: true, data: { recognized: true, messages: [{ messageId: "m".repeat(64), sender: id, recipient: id, body, createdAt: stamp, expiresAt: stamp, deliveryAttempt: 99, firstDeliveredAt: stamp }], managed: true, retired: true } })) + 1;
  const prepare = Buffer.byteLength(JSON.stringify({ protocolVersion: "1.0.0", token: "t".repeat(43), operation: "prepare", payload: { sender: id, target: id, body, ttlSeconds: 86400 } })) + 1;
  rows[name] = { bodyBytes, worstHookClaimLine: claim, worstPrepareLine: prepare };
}
console.log(JSON.stringify(rows, null, 1));
