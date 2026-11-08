import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { ROOT } from "../../scripts/lib.mjs";

// Read Git's small, non-ZIP64 archives without an external unzip dependency.
// Names come from the central directory; payload offsets come from local headers.
function zipFiles(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "ZIP end of central directory is present");
  const files = new Map();
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const payload = bytes.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, "Git ZIP uses stored or deflated entries");
    files.set(name, method === 8 ? inflateRawSync(payload) : payload);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test("AGS3-D-0028: actual install ZIP retains the official plugin identity and one ags server", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "ags38-agy-package-"));
  try {
    const out = path.join(temporary, "package.zip");
    execFileSync(process.execPath, [
      path.join(ROOT, "scripts/build-antigravity-package.mjs"), "--ref", "HEAD", "--out", out,
    ], { cwd: ROOT, stdio: "pipe" });
    const files = zipFiles(readFileSync(out));
    const prefix = "agent-governance-suite/";
    const manifestBytes = files.get(prefix + "plugin.json");
    assert.ok(manifestBytes, "install ZIP must contain the current official root plugin.json");
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const source = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(manifest.name, "agent-governance-suite");
    assert.equal(manifest.version, source.version);
    const legacy = JSON.parse(files.get(prefix + ".gemini-plugin/plugin.json").toString("utf8"));
    assert.deepEqual(manifest, legacy, "current and compatibility manifest identities agree");
    const config = JSON.parse(files.get(prefix + "mcp_config.json").toString("utf8"));
    assert.deepEqual(Object.keys(config.mcpServers), ["ags"]);
    assert.equal(config.mcpServers.ags.env.AGENT_GOVERNANCE_HOST_ATTESTATION, "antigravity");
    // 4.0.0 renders everything in MODEL_LOCALE; no package locale file ships any more.
    assert.equal(files.has(prefix + "runtime/locale.json"), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
