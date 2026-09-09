#!/usr/bin/env python3
"""Validate the independent-deliberation-panel skill in the suite layout."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


MONOREPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_ID = "independent-deliberation-panel"
SKILL_VERSION = "1.0.0"
SKILL_ROOT = MONOREPO_ROOT / "skills" / SKILL_ID
TEST_ROOT = Path(__file__).resolve().parent
REQUIRED_FILES = (
    "SKILL.md",
    "LICENSE",
    "agents/openai.yaml",
    "contracts/decision-record.v1.schema.json",
    "contracts/requirements.json",
    "references/evidence-and-verdict-schema.md",
    "references/integration-contract.md",
    "references/orchestration-policy.md",
    "references/role-catalog.md",
    "scripts/run_evals.py",
    "scripts/summarize_evals.py",
    "scripts/validate_decision_record.py",
    "scripts/validate_package.py",
)
EXPECTED_CASE_KINDS = {"normal", "boundary", "expected-failure"}
EXPECTED_PACKAGE_SUMMARY = (
    "PACKAGE VALID: 24 requirements, 24 valid fixtures, 24 invalid fixtures, "
    "20 semantic regressions, 6 evaluation-gate regressions, 6 scenarios"
)


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
    require(f'version: "{SKILL_VERSION}"' in read_utf8(SKILL_ROOT / "SKILL.md"),
            f"SKILL.md metadata.version must be {SKILL_VERSION}")
    openai_yaml = read_utf8(SKILL_ROOT / "agents" / "openai.yaml")
    require(f"${SKILL_ID}" in openai_yaml,
            "agents/openai.yaml default_prompt must support direct invocation")
    require(re.search(r"^\s*allow_implicit_invocation:\s*true\s*$", openai_yaml, re.MULTILINE) is not None,
            "agents/openai.yaml must allow implicit invocation")


def validate_decision_record_contracts() -> None:
    """Run the imported package's deterministic schema and regression suite."""
    package_validator = SKILL_ROOT / "scripts" / "validate_package.py"
    try:
        result = subprocess.run(
            [sys.executable, str(package_validator)],
            cwd=SKILL_ROOT,
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValidationError(f"cannot run DecisionRecord.v1 contract suite: {error}") from error

    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    require(
        result.returncode == 0,
        "DecisionRecord.v1 contract suite failed" + (f":\n{output}" if output else ""),
    )
    require(
        EXPECTED_PACKAGE_SUMMARY in result.stdout,
        "DecisionRecord.v1 contract suite did not confirm the expected 24/24 fixtures "
        "and semantic/evaluation regressions",
    )


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
    checks = (validate_skill_package, validate_decision_record_contracts, validate_behavior_cases)
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
