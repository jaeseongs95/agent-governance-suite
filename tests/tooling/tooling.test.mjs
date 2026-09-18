import { describe, expect, it } from "vitest";
import {
  NAME_PATTERN,
  normalizeChecksumContent,
  parseArguments,
  readFrontmatter
} from "../../scripts/lib.mjs";
import { assertMarkerPair, replaceExactlyOnce, syncReleaseMetadata } from "../../scripts/release-metadata.mjs";
import { compareVersions, isSameVersionPinMismatch, isUpstreamUpdate, stableTagsFromLsRemote } from "../../scripts/source-lock.mjs";

describe("repository tooling", () => {
  it("reads single-line and YAML block scalar frontmatter values", () => {
    expect(readFrontmatter("---\nname: plain\ndescription: \"A quoted one-line description.\"\n---\n")).toEqual({
      name: "plain",
      description: "A quoted one-line description.",
    });
    expect(readFrontmatter("---\nname: folded\ndescription: >\n  First line\n  second line.\nlicense: MIT\n---\n")).toEqual({
      name: "folded",
      description: "First line second line.",
      license: "MIT",
    });
    expect(readFrontmatter("---\nname: literal\ndescription: |-\n  one\n  two\n---\n").description).toBe("one\ntwo");
  });

  it("normalizes CRLF text without changing binary content", () => {
    expect(normalizeChecksumContent(Buffer.from("one\r\ntwo\r\n"))).toEqual(Buffer.from("one\ntwo\n"));
    expect(normalizeChecksumContent(Buffer.from([0xff, 0x00, 0x0d, 0x0a])))
      .toEqual(Buffer.from([0xff, 0x00, 0x0d, 0x0a]));
  });

  it("parses named command arguments", () => {
    expect(parseArguments(["--name", "example-skill", "--phase", "validation"])).toEqual({
      name: "example-skill",
      phase: "validation"
    });
  });

  it("accepts only kebab-case skill names", () => {
    expect(NAME_PATTERN.test("valid-skill-2")).toBe(true);
    expect(NAME_PATTERN.test("Invalid_Skill")).toBe(false);
  });

  it("reads required frontmatter fields", () => {
    expect(readFrontmatter("---\nname: example\ndescription: Example description\n---\n")).toMatchObject({
      name: "example",
      description: "Example description"
    });
  });

  it("selects only exact stable semantic-version tags and peels annotated tags", () => {
    const tags = stableTagsFromLsRemote([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/tags/v1.2.0",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v1.2.0^{}",
      "cccccccccccccccccccccccccccccccccccccccc refs/tags/v1.3.0-rc.1",
      "dddddddddddddddddddddddddddddddddddddddd refs/tags/release-2.0.0",
      "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee refs/tags/v2.0.0",
    ].join("\n"));
    expect(tags).toEqual([
      { tag: "v2.0.0", version: "2.0.0", commit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      { tag: "v1.2.0", version: "1.2.0", commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ]);
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("does not treat a same-version commit pin that differs from the tag as an update", () => {
    const pinned = { version: "1.0.0", ref: { kind: "commit", value: "a", commit: "a" } };
    const differentCommit = { tag: "v1.0.0", version: "1.0.0", commit: "b" };
    expect(isUpstreamUpdate(pinned, differentCommit)).toBe(false);
    expect(isSameVersionPinMismatch(pinned, differentCommit)).toBe(true);
    // The tag names the pinned commit: moving the lock onto the tag changes no content.
    const sameCommit = { tag: "v1.0.0", version: "1.0.0", commit: "a" };
    expect(isUpstreamUpdate(pinned, sameCommit)).toBe(true);
    expect(isSameVersionPinMismatch(pinned, sameCommit)).toBe(false);
    // A higher stable version is an update for every pin kind; a lower one never is.
    expect(isUpstreamUpdate(pinned, { tag: "v1.1.0", version: "1.1.0", commit: "c" })).toBe(true);
    expect(isSameVersionPinMismatch(pinned, { tag: "v1.1.0", version: "1.1.0", commit: "c" })).toBe(false);
    expect(isUpstreamUpdate(pinned, { tag: "v0.9.0", version: "0.9.0", commit: "c" })).toBe(false);
    expect(isUpstreamUpdate(pinned, null)).toBe(false);
    // A tag pin keeps reporting a moved tag and stays quiet when nothing changed.
    const tagged = { version: "1.0.0", ref: { kind: "tag", value: "v1.0.0", commit: "a" } };
    expect(isUpstreamUpdate(tagged, differentCommit)).toBe(true);
    expect(isSameVersionPinMismatch(tagged, differentCommit)).toBe(false);
    expect(isUpstreamUpdate(tagged, sameCommit)).toBe(false);
  });

  it("fails closed when a release marker is missing or duplicated", () => {
    expect(() => replaceExactlyOnce("none", /start.*end/u, "x", "test")).toThrow(/exactly once/u);
    expect(() => replaceExactlyOnce("start end start end", /start end/u, "x", "test")).toThrow(/found 2/u);
    expect(() => assertMarkerPair("<!-- release:start --><!-- release:start --><!-- release:end -->", "release", "test"))
      .toThrow(/found 2/u);
  });

  it("keeps every generated release surface synchronized", async () => {
    await expect(syncReleaseMetadata()).resolves.toEqual([]);
  });
});
