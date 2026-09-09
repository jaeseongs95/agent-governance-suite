import { describe, expect, it } from "vitest";
import {
  NAME_PATTERN,
  normalizeChecksumContent,
  parseArguments,
  readFrontmatter
} from "../../scripts/lib.mjs";

describe("repository tooling", () => {
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
});
