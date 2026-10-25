import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { findPython } from "../../scripts/python-runner.mjs";

// SOURCE ONLY: all provider invocations below are mocked; never call a model.
const regression = String.raw`
import copy
import contextlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

root = Path(sys.argv[1]) / "skills" / "independent-deliberation-panel"
sys.path.insert(0, str(root / "scripts"))
import run_evals as subject
from validate_decision_record import validate, validate_issues

def fixture(name):
    return json.loads((root / "evals" / "fixtures" / "valid" / name).read_text(encoding="utf-8"))

def fake_evaluations(records):
    pending = iter(copy.deepcopy(records))
    observed = []
    def fake_run(command, **kwargs):
        if command == ["codex", "--version"]:
            return subprocess.CompletedProcess(command, 0, "codex-fixture\n", "")
        assert command[:2] == ["codex", "exec"], command
        candidate = Path(kwargs["cwd"]) / ".agents" / "skills" / "independent-deliberation-panel"
        schema = Path(command[command.index("--output-schema") + 1])
        assert schema.is_file()
        # The generated execution schema must not mutate the hashed candidate.
        assert not schema.is_relative_to(candidate), "schema added to candidate after hashing"
        digest = subject.candidate_bundle_sha256(candidate)
        assert digest in command[-1], "prompt digest differs from executed candidate"
        observed.append(digest)
        record = next(pending)
        if record["run"].get("candidate_skill_sha256") is None:
            record["run"]["candidate_skill_sha256"] = digest
        event = {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(record)}}
        return subprocess.CompletedProcess(command, 0, json.dumps(event), "")
    with tempfile.TemporaryDirectory(prefix="cg07-results-") as directory:
        args = ["run_evals.py", "--execute", "--model", "fixture-model", "--case", "low-routing",
                "--repeat", str(len(records)), "--results-dir", directory]
        with patch.object(sys, "argv", args), patch.object(subject.subprocess, "run", side_effect=fake_run), contextlib.redirect_stdout(io.StringIO()):
            status = subject.main()
        results = [json.loads((Path(directory) / ("low-routing.r" + str(index) + ".json")).read_text(encoding="utf-8"))
                   for index in range(1, len(records) + 1)]
    assert len(observed) == len(records)
    assert len(set(observed)) == 1, "candidate changed between repeats"
    return status, results

case = sys.argv[2]
if case == "planner":
    for flags in ([], ["--dry-run"], ["--dry-run", "--execute", "--model", "fixture-model"]):
        with tempfile.TemporaryDirectory(prefix="cg07-plan-") as directory:
            results = Path(directory) / "not-created"
            args = ["run_evals.py", "--case", "low-routing", "--results-dir", str(results), *flags]
            with patch.object(sys, "argv", args), patch.object(subject.subprocess, "run", side_effect=AssertionError("planner launched CLI")) as runner, contextlib.redirect_stdout(io.StringIO()):
                assert subject.main() == 0
                runner.assert_not_called()
            assert not results.exists()
elif case == "candidate":
    low = fixture("rc01_low_no_workers.json")
    status, results = fake_evaluations([low, low])
    assert status == 0, results
    assert all(result["candidate_bundle_sha256"] == result["observed_candidate_bundle_sha256"] for result in results)
elif case == "cross":
    high = fixture("rc03_high_fresh_judge.json")
    assert validate(high) == []
    origin = high["cross_examination"]["trigger_items"][0]["origin_reviewer"]
    target = high["cross_examination"]["coverage"][0]["reviewer_ids"][0]
    item = high["cross_examination"]["selected_item_ids"][0]
    missing = copy.deepcopy(high)
    missing["cross_examination"]["coverage"][0]["reviewer_ids"] = [origin, target]
    missing["cross_examination"]["followups"] = [{"reviewer_id": origin, "item_ids": [item]}]
    assert any(code == "cross.coverage" for code, _ in validate_issues(missing)), "origin-only followup hid missing non-origin review"
    complete = copy.deepcopy(missing)
    complete["cross_examination"]["followups"].append({"reviewer_id": target, "item_ids": [item]})
    assert validate(complete) == []
    extra = copy.deepcopy(high)
    extra["cross_examination"]["followups"].append({"reviewer_id": origin, "item_ids": [item]})
    assert any(code == "cross.followup" for code, _ in validate_issues(extra)), "followup without coverage accepted"
elif case == "privacy":
    low = fixture("rc01_low_no_workers.json")
    records = []
    invalid = [{"private": "CG07_PRIVATE_SENTINEL"}, ["CG07_PRIVATE_SENTINEL"], "CG07_PRIVATE_SENTINEL", True, -1, 1.5, None]
    for value in invalid:
        record = copy.deepcopy(low)
        record["observability"].update(tokens=value, tool_calls=value)
        record["run"]["assurance"] = "CG07_PRIVATE_SENTINEL"
        record["run"]["candidate_skill_sha256"] = "CG07_PRIVATE_SENTINEL"
        records.append(record)
    for value in (0, 7):
        record = copy.deepcopy(low)
        record["observability"].update(tokens=value, tool_calls=value)
        records.append(record)
    status, results = fake_evaluations(records)
    assert status == 1
    assert "CG07_PRIVATE_SENTINEL" not in json.dumps(results)
    for result in results[:len(invalid)]:
        assert result["tokens"] == result["tool_calls"] == result["assurance"] == "NOT_OBSERVABLE"
        assert result["observed_candidate_bundle_sha256"] is None
        assert result["outcome"] != "ok"
    for value, result in zip((0, 7), results[len(invalid):]):
        assert result["tokens"] == result["tool_calls"] == value
        assert result["assurance"] == "single_agent"
elif case == "assurance-shape":
    records = []
    for value in ({}, [], {"private": "CG07_ASSURANCE_SENTINEL"}, ["CG07_ASSURANCE_SENTINEL"]):
        record = fixture("rc01_low_no_workers.json")
        record["run"]["assurance"] = value
        records.append(record)
    status, results = fake_evaluations(records)
    assert status == 1
    assert len(results) == len(records), "validation aborted before JSON result persistence"
    assert "CG07_ASSURANCE_SENTINEL" not in json.dumps(results)
    for result in results:
        assert result["outcome"] == "semantic_invalid"
        assert "run.assurance" in result["validation_error_codes"]
        assert "schema.type" in result["validation_error_codes"]
        assert result["assurance"] == "NOT_OBSERVABLE"
else:
    raise AssertionError("unknown regression case")
`;

it.each(["planner", "candidate", "cross", "privacy", "assurance-shape"])("CG07 %s boundary", (caseName) => {
  const python = findPython();
  const result = spawnSync(python.command, [...python.prefix, "-B", "-c", regression,
    path.resolve(import.meta.dirname, "../.."), caseName], {
    encoding: "utf8",
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 30_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
