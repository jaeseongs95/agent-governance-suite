#!/usr/bin/env python3
"""Validate the independent-deliberation-panel skill in the suite layout."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


MONOREPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_ID = "independent-deliberation-panel"
SKILL_ROOT = MONOREPO_ROOT / "skills" / SKILL_ID
TEST_ROOT = Path(__file__).resolve().parent
REQUIRED_FILES = (
    "SKILL.md",
    "LICENSE",
    "agents/openai.yaml",
    "references/evidence-and-verdict-schema.md",
    "references/role-catalog.md",
)
EXPECTED_CASE_KINDS = {"normal", "boundary", "expected-failure"}


class ValidationError(Exception):
    """A validation error that should be reported without a traceback."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def read_utf8(path: Path) -> str:
    require(path.is_file(), f"required file is missing: {path.relative_to(MONOREPO_ROOT)}")
    return path.read_text(encoding="utf-8")


def parse_frontmatter(text: str) -> dict[str, str]:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.DOTALL)
    require(match is not None, "SKILL.md must begin with YAML frontmatter")
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if line.startswith((" ", "\t")) or ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip('"\'')
    return fields


def validate_skill_package() -> None:
    for relative in REQUIRED_FILES:
        read_utf8(SKILL_ROOT / relative)
    frontmatter = parse_frontmatter(read_utf8(SKILL_ROOT / "SKILL.md"))
    require(frontmatter.get("name") == SKILL_ID,
            f"SKILL.md frontmatter name must be {SKILL_ID!r}")
    require(frontmatter.get("license") == "MIT", "SKILL.md frontmatter license must be MIT")
    require('version: "0.1.0"' in read_utf8(SKILL_ROOT / "SKILL.md"),
            "SKILL.md metadata.version must remain 0.1.0")
    openai_yaml = read_utf8(SKILL_ROOT / "agents" / "openai.yaml")
    require(f"${SKILL_ID}" in openai_yaml,
            "agents/openai.yaml default_prompt must support direct invocation")
    require(re.search(r"^\s*allow_implicit_invocation:\s*true\s*$", openai_yaml, re.MULTILINE) is not None,
            "agents/openai.yaml must allow implicit invocation")


def validate_behavior_cases() -> None:
    document = json.loads(read_utf8(TEST_ROOT / "behavior-cases.json"))
    require(document.get("schemaVersion") == "1.0", "behavior cases must declare schemaVersion 1.0")
    cases = document.get("cases")
    require(isinstance(cases, list) and len(cases) == 3,
            "behavior cases must contain exactly three initial cases")
    kinds = {case.get("kind") for case in cases if isinstance(case, dict)}
    require(kinds == EXPECTED_CASE_KINDS,
            f"behavior case kinds differ; expected {sorted(EXPECTED_CASE_KINDS)}")
    for case in cases:
        require(isinstance(case.get("id"), str) and case["id"], "each behavior case requires an id")
        require(isinstance(case.get("input"), str) and case["input"], "each behavior case requires an input")
        require(isinstance(case.get("expected"), str) and case["expected"], "each behavior case requires an expected outcome")


def main() -> int:
    checks = (validate_skill_package, validate_behavior_cases)
    failures: list[str] = []
    for check in checks:
        try:
            check()
            print(f"PASS {check.__name__}")
        except (ValidationError, UnicodeDecodeError, json.JSONDecodeError) as error:
            failures.append(f"FAIL {check.__name__}: {error}")
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("All independent-deliberation-panel validations passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
