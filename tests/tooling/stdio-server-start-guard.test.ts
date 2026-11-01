import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// A test that starts an STDIO server inside its own body spends its time limit on process start, module load and the
// initialize handshake, which a loaded runner can exceed (the D0363/Windows STDIO timeouts). Tests start STDIO servers
// only through tests/helpers/stdio-server.ts, whose start step runs before the test's timer and whose `connect` refuses
// once that step has ended. This check keeps a direct SDK client transport from coming back into any test source.
const root = fileURLToPath(new URL("../../", import.meta.url));
const transportName = ["Stdio", "Client", "Transport"].join("");
const allowed = new Set(["tests/helpers/stdio-server.ts"]);

async function sources(directory: string, accept: (file: string) => boolean): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter(file => !file.split("/").includes("node_modules") && accept(file));
}

it("starts STDIO servers in tests only through the start-step helper", async () => {
  const files = [
    ...await sources("tests", file => /\.(?:[cm]?[jt]s)$/u.test(file)),
    ...await sources("antigravity-connector", file => /\.test\.(?:[cm]?[jt]s)$/u.test(file)),
  ];
  expect(files).toContain("tests/helpers/stdio-server.ts");
  const offending: string[] = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    if ((await readFile(path.join(root, file), "utf8")).includes(transportName)) offending.push(file);
  }
  expect(offending, "start STDIO servers with stdioServerTests/stdioServerForSuite from tests/helpers/stdio-server.ts").toEqual([]);
});
