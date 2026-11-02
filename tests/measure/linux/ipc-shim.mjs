// M2 minimal shim: hello, then stdin -> socket and socket -> stdout. No store, no logger.
// usage: node ipc-shim.mjs <socketPath>
import net from "node:net";

const s = net.connect(process.argv[2]);
s.once("connect", () => s.write(JSON.stringify({ ags: "hello", protocol: 1, role: "mcp", client: { kind: "shim" } }) + "\n"));
let pre = "";
const onWelcome = (d) => {
  pre += d;
  const i = pre.indexOf("\n");
  if (i < 0) return;
  s.off("data", onWelcome);
  const rest = pre.slice(i + 1);
  if (rest) process.stdout.write(rest);
  process.stdin.pipe(s);
  s.pipe(process.stdout);
};
s.on("data", onWelcome);
s.on("error", (e) => {
  process.stderr.write("shim: " + e.code + "\n");
  process.exit(1);
});
process.stdin.on("end", () => s.end());
