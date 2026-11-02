// Shared line-JSON client for the measurement scripts.
import net from "node:net";

export function connect(sock) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    let buf = "";
    let welcomed = false;
    let nextId = 1;
    const pending = new Map();
    s.once("error", reject);
    s.once("connect", () => s.write(JSON.stringify({ ags: "hello", protocol: 1, role: "rpc", client: { kind: "measure" } }) + "\n"));
    s.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (!welcomed) {
          welcomed = true;
          s.off("error", reject);
          s.on("error", () => {});
          resolve({
            welcome: msg,
            request(method, params) {
              const id = nextId++;
              return new Promise((res) => {
                pending.set(id, res);
                s.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
              });
            },
            close: () => s.end(),
            destroy: () => s.destroy(),
          });
          continue;
        }
        const r = pending.get(msg.id);
        pending.delete(msg.id);
        r?.(msg);
      }
    });
  });
}

export const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 1000) / 1000;
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
