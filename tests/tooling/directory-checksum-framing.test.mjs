import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeDirectoryChecksum as toolingChecksum } from "../../scripts/lib.mjs";
import { computeDirectoryChecksum as readinessChecksum } from "../../scripts/korean-prose-readiness.ts";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function tree(entries) {
  const root = await mkdtemp(path.join(tmpdir(), "ags-d125-"));
  roots.push(root);
  for (const [relative, content] of entries) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

describe.each([
  ["tooling", toolingChecksum],
  ["readiness", readinessChecksum],
])("D125 directory checksum framing: %s", (_name, checksum) => {
  it("distinguishes the original relative-path/content collision", async () => {
    const left = await tree([["references/a", "bc"]]);
    const right = await tree([["references/ab", "c"]]);
    expect(await checksum(left)).not.toBe(await checksum(right));
  });

  it("distinguishes content from the next file's path", async () => {
    const left = await tree([["a", "bc"], ["d", "e"]]);
    const right = await tree([["a", "b"], ["cd", "e"]]);
    expect(await checksum(left)).not.toBe(await checksum(right));
  });

  it("uses UTF-8 byte lengths for each field", async () => {
    const root = await tree([["한", "é"]]);
    const expected = createHash("sha256").update("3:한2:é").digest("hex");
    expect(await checksum(root)).toBe(`sha256:${expected}`);
  });

  it("preserves sorted paths and normalized CRLF text", async () => {
    const left = await tree([["z", "last\r\n"], ["a", "first\r\n"]]);
    const right = await tree([["a", "first\n"], ["z", "last\n"]]);
    expect(await checksum(left)).toBe(await checksum(right));
  });

  it("preserves NUL and invalid UTF-8 binary bytes", async () => {
    for (const prefix of [Buffer.from([0]), Buffer.from([0xff])]) {
      const left = await tree([["a", Buffer.concat([prefix, Buffer.from("\r\n")])]]);
      const right = await tree([["a", Buffer.concat([prefix, Buffer.from("\n")])]]);
      expect(await checksum(left)).not.toBe(await checksum(right));
    }
  });

  it("distinguishes an empty file from an empty tree", async () => {
    expect(await checksum(await tree([["a", ""]]))).not.toBe(await checksum(await tree([])));
  });

  it("preserves the original missing-directory error code", async () => {
    const root = await tree([]);
    await expect(checksum(path.join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
