#!/usr/bin/env python3
"""Summarize deterministic fixtures and sanitized live-evaluation metadata."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_decision_record.py"
sys.path.insert(0, str(ROOT / "scripts"))
from run_evals import candidate_bundle_sha256


def fixture_result(path: Path) -> bool:
    return subprocess.run([sys.executable, str(VALIDATOR), str(path)], capture_output=True).returncode == 0


def load_live_results(results_dir: Path) -> tuple[list[dict], list[str]]:
    """Load result files while preserving read failures as gate-visible errors."""
    live: list[dict] = []
    errors: list[str] = []
    if not results_dir.exists():
        return live, [f"results directory does not exist: {results_dir}"]
    for path in sorted(results_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            errors.append(f"cannot read result {path.name}: {exc.__class__.__name__}")
            continue
        if not isinstance(data, dict):
            errors.append(f"result {path.name} is not a JSON object")
            continue
        # File names are useful diagnostics only. The signed result metadata is
        # what determines the case/repeat identity.
        live.append({**data, "file": path.name})
    return live, errors


def behavior_gate_errors(live: list[dict], read_errors: list[str]) -> list[str]:
    """Return behavior-test errors for one run of each fixed corpus case."""
    errors = list(read_errors)
    corpus = []
    for path in sorted((ROOT / "evals" / "corpus").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            case_id = data.get("id") if isinstance(data, dict) else None
            if not isinstance(case_id, str) or not case_id:
                errors.append(f"invalid corpus case: {path.name}")
            else:
                corpus.append(case_id)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            errors.append(f"cannot read corpus case {path.name}: {exc.__class__.__name__}")
    if len(corpus) != 6 or len(set(corpus)) != 6:
        errors.append("behavior gate requires exactly six unique corpus cases")
    expected = {(case_id, 1) for case_id in corpus}
    current_sha = candidate_bundle_sha256(ROOT)
    seen: dict[tuple[str, int], str] = {}
    for result in live:
        label = result.get("file", "<unknown>")
        case_id, repeat = result.get("case_id"), result.get("repeat")
        key = (case_id, repeat)
        if not isinstance(case_id, str) or not isinstance(repeat, int):
            errors.append(f"result {label} lacks a valid case_id/repeat")
            continue
        if key in seen:
            errors.append(f"duplicate result for {case_id} repeat {repeat}: {seen[key]}, {label}")
        else:
            seen[key] = label
        if key not in expected:
            errors.append(f"unexpected result: {case_id} repeat {repeat} ({label})")
        if result.get("candidate_bundle_sha256") != current_sha or result.get("observed_candidate_bundle_sha256") != current_sha:
            errors.append(f"candidate SHA mismatch: {label}")
        if result.get("runner_model") in {None, "", "default", "NOT_OBSERVABLE"}:
            errors.append(f"runner model identity unavailable: {label}")
        if result.get("runner_cli_version") in {None, "", "NOT_OBSERVABLE"}:
            errors.append(f"runner CLI identity unavailable: {label}")
        if result.get("outcome") != "ok" or result.get("exit_code") != 0:
            errors.append(f"run did not succeed: {label}")
        # Require the canonical keys; compatibility aliases alone cannot make a
        # behavior pass because a producer might otherwise omit an error channel.
        validation_errors = result.get("validation_errors")
        behavior_errors = result.get("behavior_errors")
        if not isinstance(validation_errors, list) or validation_errors:
            errors.append(f"validation errors present or unavailable: {label}")
        if not isinstance(behavior_errors, list) or behavior_errors:
            errors.append(f"behavior errors present or unavailable: {label}")
        actual_spawned = result.get("actual_spawned_workers_count")
        actual_completed = result.get("actual_completed_workers_count")
        recorded_spawned = result.get("recorded_manifest_workers_count")
        recorded_completed = result.get("recorded_completed_workers_count")
        if not all(isinstance(value, int) and value >= 0 for value in (actual_spawned, actual_completed, recorded_spawned, recorded_completed)):
            errors.append(f"worker metrics unavailable: {label}")
        elif actual_spawned != recorded_spawned or actual_completed != recorded_completed:
            errors.append(f"actual/recorded worker count mismatch: {label}")
        if result.get("spawned_ids_match_manifest") is not True or result.get("completed_ids_match_record") is not True:
            errors.append(f"worker identity attestation failed: {label}")
        if result.get("failed_wait_calls") != 0:
            errors.append(f"failed waiter observed: {label}")
        if result.get("failed_followup_calls") != 0:
            errors.append(f"failed cross-examination follow-up observed: {label}")
        if case_id != "low-routing" and (result.get("successful_wait_calls", 0) < 1 or actual_spawned != actual_completed):
            errors.append(f"non-LOW workers were not all observed completed: {label}")
        if case_id in {"high-cross-exam-skip", "high-adaptive", "injection-unverified", "critical-no-consensus"} and result.get("fresh_judge_after_deliberation") is not True:
            errors.append(f"fresh Judge was not observed after deliberation: {label}")
        if case_id in {"high-cross-exam-skip", "high-adaptive", "injection-unverified", "critical-no-consensus"} and result.get("fresh_judge_completed_after_spawn") is not True:
            errors.append(f"fresh Judge completion order was not observed: {label}")
        if case_id in {"high-adaptive", "injection-unverified", "critical-no-consensus"}:
            if result.get("reviewers_completed_before_cross") is not True or result.get("cross_targets_match_record") is not True:
                errors.append(f"cross-examination event order or targets were not observed: {label}")
        if result.get("record_declared_roles_and_stages") is not True:
            errors.append(f"record-declared roles/stages unavailable: {label}")
        if result.get("runtime_isolation_evidence") != "NOT_OBSERVABLE" or result.get("hidden_system_prompt_evidence") != "NOT_OBSERVABLE":
            errors.append(f"unsupported runtime/system-prompt assurance claim: {label}")

        stage = result.get("record_stage")
        reviewers = result.get("recorded_reviewer_count")
        judges = result.get("recorded_judge_count")
        specialists = result.get("recorded_specialist_count")
        redeliberations = result.get("recorded_redeliberation_count")
        assurance = result.get("assurance")
        consensus = result.get("consensus_status")
        cross = result.get("cross_examination_decision")
        case_ok = False
        case_counts = (reviewers, judges, specialists, redeliberations)
        counts_available = all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in case_counts)
        if not counts_available:
            errors.append(f"case-specific worker counts unavailable: {label}")
        elif case_id == "low-routing":
            case_ok = stage == "LOW" and actual_spawned == actual_completed == reviewers == judges == specialists == redeliberations == 0 and assurance == "single_agent"
        elif case_id == "medium-contract-conflict":
            case_ok = stage == "MEDIUM" and 2 <= reviewers <= 3 and judges == specialists == redeliberations == 0 and actual_spawned == reviewers and assurance == "partially_independent"
        elif case_id == "high-cross-exam-skip":
            case_ok = stage == "HIGH" and reviewers >= 4 and judges == 1 and specialists == redeliberations == 0 and cross == "skip" and assurance == "independent" and result.get("followup_calls") == 0
        elif case_id == "high-adaptive":
            case_ok = stage == "HIGH" and reviewers >= 4 and judges == specialists == redeliberations == 1 and cross == "run" and assurance == "partially_independent" and result.get("followup_calls", 0) >= 1
        elif case_id == "injection-unverified":
            case_ok = (stage == "HIGH" and reviewers >= 4 and judges == 1 and cross == "run"
                       and result.get("followup_calls", 0) >= 1
                       and result.get("has_nonverified_provenance") is True
                       and result.get("nonverified_claims_linked_to_consensus") is False)
        elif case_id == "critical-no-consensus":
            case_ok = (stage == "CRITICAL" and 5 <= reviewers <= 6 and judges == 1
                       and cross == "run" and result.get("followup_calls", 0) >= 1
                       and result.get("critical_design_assurance_present") is True
                       and consensus == "no_consensus" and result.get("no_consensus_complete") is True)
        if not case_ok:
            errors.append(f"case-specific execution attestation failed: {label}")
    missing = expected - set(seen)
    for case_id, repeat in sorted(missing):
        errors.append(f"missing result for {case_id} repeat {repeat}")
    if len(live) != 6:
        errors.append(f"behavior gate requires exactly six readable result files, found {len(live)}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize panel fixtures and sanitized live evaluation results")
    parser.add_argument("--results-dir", type=Path, default=ROOT / "evals" / "results")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--behavior-gate", action="store_true", help="require one successful run of every behavior corpus case")
    args = parser.parse_args()
    valid = sorted((ROOT / "evals" / "fixtures" / "valid").glob("*.json"))
    invalid = sorted((ROOT / "evals" / "fixtures" / "invalid").glob("*.json"))
    accepted_valid = sum(fixture_result(path) for path in valid)
    rejected_invalid = sum(not fixture_result(path) for path in invalid)
    live, read_errors = load_live_results(args.results_dir)
    gate_errors = behavior_gate_errors(live, read_errors) if args.behavior_gate else []
    summary = {"fixture_valid": {"passed": accepted_valid, "total": len(valid)}, "fixture_invalid": {"rejected": rejected_invalid, "total": len(invalid)}, "hard_invariant_failures": (len(valid) - accepted_valid) + (len(invalid) - rejected_invalid), "live_runs": live, "live_result_read_errors": read_errors, "behavior_gate": {"passed": not gate_errors, "errors": gate_errors} if args.behavior_gate else "not_requested", "observability": {"wall_time_seconds": "recorded when an invocation ran", "tokens": "NOT_OBSERVABLE unless a sanitized provider metric is added", "tool_calls": "NOT_OBSERVABLE unless a sanitized provider metric is added", "workers": "sanitized aggregate counts only"}, "raw_chain_of_thought_stored": False}
    if args.json: print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(f"Fixtures: valid {accepted_valid}/{len(valid)}; invalid rejected {rejected_invalid}/{len(invalid)}")
        print(f"Hard invariant failures: {summary['hard_invariant_failures']}")
        print(f"Live runs: {len(live)}")
        if read_errors: print(f"Live result read errors: {len(read_errors)}")
        if args.behavior_gate:
            print(f"Behavior gate: {'PASS' if not gate_errors else 'FAIL'}")
            for error in gate_errors: print(f"- {error}")
        print("Observable: wall time when run; tokens/tool calls/workers: NOT_OBSERVABLE unless sanitized metrics are supplied.")
        print("Raw chain-of-thought stored: no")
    return 1 if args.behavior_gate and gate_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
