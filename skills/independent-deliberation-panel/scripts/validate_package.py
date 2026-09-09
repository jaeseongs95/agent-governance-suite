#!/usr/bin/env python3
"""Repository-local contract check for the v1 panel package."""
from __future__ import annotations

import copy
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

from validate_decision_record import validate, validate_issues

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "scripts" / "validate_decision_record.py"
EXPECTED = {"routing_capability": 4, "cross_exam": 4, "evidence_security": 5, "consensus": 5, "adaptive": 4, "lifecycle_fallback": 2}


def regression_errors() -> list[str]:
    """Exercise cross-field invariants that one-mutation fixtures can miss."""
    fixture_root = ROOT / "evals" / "fixtures" / "valid"
    high = json.loads((fixture_root / "rc03_high_fresh_judge.json").read_text(encoding="utf-8"))
    medium = json.loads((fixture_root / "rc02_medium_two_reviewers.json").read_text(encoding="utf-8"))
    adaptive = json.loads((fixture_root / "ad01_specialist_cap.json").read_text(encoding="utf-8"))
    redeliberation = json.loads((fixture_root / "ad03_impacted_scope.json").read_text(encoding="utf-8"))
    shortfall = json.loads((fixture_root / "lf02_judge_fallback.json").read_text(encoding="utf-8"))
    failures: list[str] = []

    negative: list[tuple[str, dict]] = []

    record = copy.deepcopy(shortfall)
    record["material_claims"] = copy.deepcopy(high["material_claims"][:1])
    negative.append(("strict substantive artifact", record))

    record = copy.deepcopy(high)
    record["run"]["workers"][0]["instantiated"] = False
    record["panel_manifest"][0]["instantiated"] = False
    negative.append(("completed but uninstantiated worker", record))

    record = copy.deepcopy(high)
    record["cross_examination"]["coverage"][0]["reviewer_ids"] = ["ghost"]
    negative.append(("ghost cross reviewer", record))

    record = copy.deepcopy(high)
    record["cross_examination"]["coverage"][0]["reviewer_ids"] = ["judge"]
    negative.append(("Judge used as cross reviewer", record))

    record = copy.deepcopy(high)
    record["axis_decisions"][0]["evidence_claim_ids"] = ["missing-claim"]
    negative.append(("missing axis claim", record))

    record = copy.deepcopy(high)
    record["axis_decisions"][0]["evidence_claim_ids"] = ["C2"]
    negative.append(("unverified axis claim", record))

    record = copy.deepcopy(high)
    record["run"]["specialist_additions"] = [{
        "id": "bad-specialist",
        "reason": "Invalid Judge reuse.",
        "admission_reason": "Invalid Judge reuse.",
        "worker_id": "judge",
        "classification": "adaptive_specialist",
        "admission": {"material_gap": True, "distinct_capability": True, "verdict_change_possible": True, "cap_available": True},
    }]
    negative.append(("Judge reused as specialist", record))

    record = copy.deepcopy(redeliberation)
    record["run"]["redeliberations"][0]["impacted_scope"] = ["ghost-scope"]
    negative.append(("ghost re-deliberation scope", record))

    record = copy.deepcopy(adaptive)
    record["run"]["assurance"] = "independent"
    negative.append(("independent assurance after adaptive work", record))

    record = copy.deepcopy(high)
    record["panel_manifest"][0]["role"] = "Different role"
    negative.append(("manifest object mismatch", record))

    record = copy.deepcopy(high)
    record["cross_examination"] = {"decision": "run", "reason": "Claimed without work.", "trigger_items": [], "selected_item_ids": [], "coverage": [], "followups": []}
    negative.append(("empty cross-examination run", record))

    record = copy.deepcopy(high)
    record["cross_examination"]["followups"] = []
    negative.append(("cross coverage without followup", record))

    record = copy.deepcopy(high)
    record["run"]["workers"][-1]["participated_stages"] = ["redeliberation", "final_judge"]
    record["panel_manifest"][-1]["participated_stages"] = ["redeliberation", "final_judge"]
    negative.append(("Judge participated in re-deliberation", record))

    record = copy.deepcopy(high)
    hidden = copy.deepcopy(record["run"]["workers"][0])
    hidden.update({"id": "hidden-specialist", "classification": "adaptive_specialist", "blind_round1": False, "participated_stages": ["adaptive_specialist"]})
    record["run"]["workers"].append(hidden)
    record["panel_manifest"].append(copy.deepcopy(hidden))
    record["run"]["completed_worker_ids"].append(hidden["id"])
    negative.append(("adaptive worker without admission", record))

    record = copy.deepcopy(high)
    record["material_claims"] = []
    record["axis_decisions"] = []
    record["consensus_proposal"]["supported_by_verified_claims"] = []
    record["consensus_proposal"]["axis_alignment"] = []
    negative.append(("consensus without evidence or axes", record))

    record = copy.deepcopy(high)
    record["issue_ledger"] = [{"issue_id": "I1", "status": "UNRESOLVED", "rationale": "Material gap.", "required_evidence": ["source"], "available_evidence": []}]
    negative.append(("unresolved issue hidden by consensus", record))

    record = copy.deepcopy(redeliberation)
    record["run"]["redeliberations"][0]["participant_worker_ids"] = ["ghost-worker"]
    negative.append(("ghost re-deliberation participant", record))

    for label, record in negative:
        record_errors = validate(record)
        if not record_errors:
            failures.append(f"semantic regression accepted: {label}")
        elif any(code == "contract.rule_violation" for code, _ in validate_issues(record)):
            failures.append(f"semantic regression has fallback diagnostic code: {label}")

    # MEDIUM may add a truly separate fresh Judge when the user requests one.
    positive = copy.deepcopy(medium)
    judge = copy.deepcopy(high["run"]["workers"][-1])
    positive["run"]["workers"].append(judge)
    positive["panel_manifest"].append(copy.deepcopy(judge))
    positive["run"]["completed_worker_ids"].append(judge["id"])
    positive["run"]["fresh_judge_id"] = judge["id"]
    positive["run"]["assurance"] = "independent"
    positive["preflight"]["required_capabilities"].append("fresh_judge")
    positive["preflight"]["observed_capabilities"].append("fresh_judge")
    positive_errors = validate(positive)
    if positive_errors:
        failures.append("MEDIUM fresh Judge regression rejected: " + "; ".join(positive_errors))
    for stage in ("LOW", "MEDIUM"):
        positive = copy.deepcopy(shortfall)
        positive["run"]["stage"] = stage
        positive_errors = validate(positive)
        if positive_errors:
            failures.append(f"{stage} strict shortfall regression rejected: " + "; ".join(positive_errors))
    return failures


def evaluation_regression_errors() -> list[str]:
    """Keep sanitized event metrics and the six-case behavior gate executable in CI."""
    from run_evals import candidate_bundle_sha256, collaboration_metrics, reported_record, workflow_attestations
    from summarize_evals import behavior_gate_errors

    failures: list[str] = []
    synthetic_events = "\n".join(json.dumps(event) for event in [
        {"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "spawn", "status": "completed", "receiver_thread_ids": ["a"]}},
        {"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "spawn_agent", "status": "completed", "receiver_thread_ids": ["b"]}},
        {"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "wait", "status": "completed", "agents_states": {"a": {"status": "completed"}, "b": {"status": "completed"}}}},
    ])
    metrics = collaboration_metrics(synthetic_events)
    if metrics["actual_spawned_workers_count"] != 2 or metrics["actual_completed_workers_count"] != 2:
        failures.append("evaluation event metrics regression failed")

    decoy = json.loads((ROOT / "evals" / "fixtures" / "valid" / "rc01_low_no_workers.json").read_text(encoding="utf-8"))
    target = json.loads((ROOT / "evals" / "fixtures" / "valid" / "rc02_medium_two_reviewers.json").read_text(encoding="utf-8"))
    parser_events = "\n".join(json.dumps(event) for event in [
        {"type": "item.completed", "item": {"type": "collab_tool_call", "output": json.dumps(decoy)}},
        {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(target)}},
    ])
    if reported_record(parser_events) != target:
        failures.append("evaluation parser accepted a reference example instead of the final agent record")

    high_record = json.loads((ROOT / "evals" / "fixtures" / "valid" / "cx03_nonorigin_coverage.json").read_text(encoding="utf-8"))
    ordered_events = []
    for worker_id in ("r1", "r2", "r3", "r4"):
        ordered_events.append({"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "spawn_agent", "status": "completed", "receiver_thread_ids": [worker_id]}})
    ordered_events.append({"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "wait_agent", "status": "completed", "agents_states": {worker_id: {"status": "completed"} for worker_id in ("r1", "r2", "r3", "r4")}}})
    ordered_events.append({"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "followup_task", "status": "completed", "receiver_thread_ids": ["r2"]}})
    ordered_events.append({"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "wait_agent", "status": "completed", "agents_states": {"r2": {"status": "completed"}}}})
    ordered_events.append({"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "spawn_agent", "status": "completed", "receiver_thread_ids": ["judge"]}})
    ordered_events.append({"type": "item.completed", "item": {"type": "collab_tool_call", "tool": "wait_agent", "status": "completed", "agents_states": {"judge": {"status": "completed"}}}})
    ordered_jsonl = "\n".join(json.dumps(event) for event in ordered_events)
    ordered = workflow_attestations(ordered_jsonl, high_record)
    if not all(ordered.values()):
        failures.append("ordered deliberation workflow regression failed")
    judge_first = [ordered_events[-2], ordered_events[-1], *ordered_events[:-2]]
    if workflow_attestations("\n".join(json.dumps(event) for event in judge_first), high_record)["fresh_judge_after_deliberation"]:
        failures.append("workflow gate accepted Judge-first execution")
    unrelated = copy.deepcopy(ordered_events)
    unrelated[5]["item"]["receiver_thread_ids"] = ["unrelated"]
    if workflow_attestations("\n".join(json.dumps(event) for event in unrelated), high_record)["cross_targets_match_record"]:
        failures.append("workflow gate accepted unrelated cross-examination target")
    failed_followup = copy.deepcopy(ordered_events)
    failed_followup[5]["item"]["status"] = "failed"
    if workflow_attestations("\n".join(json.dumps(event) for event in failed_followup), high_record)["cross_targets_match_record"]:
        failures.append("workflow gate accepted failed cross-examination follow-up")
    wrong_wait_target = copy.deepcopy(ordered_events)
    wrong_wait_target[6]["item"]["agents_states"] = {"r1": {"status": "completed"}}
    if workflow_attestations("\n".join(json.dumps(event) for event in wrong_wait_target), high_record)["cross_targets_match_record"]:
        failures.append("workflow gate accepted cross-examination without target completion")
    extra_target = copy.deepcopy(ordered_events)
    extra_target[5]["item"]["receiver_thread_ids"] = ["r2", "r3"]
    extra_target[6]["item"]["agents_states"] = {"r2": {"status": "completed"}, "r3": {"status": "completed"}}
    if workflow_attestations("\n".join(json.dumps(event) for event in extra_target), high_record)["cross_targets_match_record"]:
        failures.append("workflow gate accepted unrecorded extra cross-examination target")

    corpus_ids = [json.loads(path.read_text(encoding="utf-8"))["id"] for path in sorted((ROOT / "evals" / "corpus").glob("*.json"))]
    candidate_sha = candidate_bundle_sha256(ROOT)
    live = []
    for case_id in corpus_ids:
        for repeat in range(1, 2):
            spec = {
                "low-routing": ("LOW", 0, 0, 0, 0, "single_agent", "consensus", "skip"),
                "medium-contract-conflict": ("MEDIUM", 2, 0, 0, 0, "partially_independent", "conditional_consensus", "run"),
                "high-cross-exam-skip": ("HIGH", 4, 1, 0, 0, "independent", "consensus", "skip"),
                "high-adaptive": ("HIGH", 4, 1, 1, 1, "partially_independent", "conditional_consensus", "run"),
                "injection-unverified": ("HIGH", 4, 1, 0, 0, "independent", "conditional_consensus", "run"),
                "critical-no-consensus": ("CRITICAL", 5, 1, 0, 0, "independent", "no_consensus", "run"),
            }[case_id]
            stage, reviewers, judges, specialists, redeliberations, assurance, consensus, cross = spec
            worker_count = reviewers + judges + specialists
            live.append({
                "file": f"{case_id}.r{repeat}.json",
                "case_id": case_id,
                "repeat": repeat,
                "runner_model": "gpt-test",
                "runner_cli_version": "codex-test",
                "candidate_bundle_sha256": candidate_sha,
                "observed_candidate_bundle_sha256": candidate_sha,
                "outcome": "ok",
                "exit_code": 0,
                "validation_errors": [],
                "behavior_errors": [],
                "actual_spawned_workers_count": worker_count,
                "actual_completed_workers_count": worker_count,
                "recorded_manifest_workers_count": worker_count,
                "recorded_completed_workers_count": worker_count,
                "record_stage": stage,
                "recorded_reviewer_count": reviewers,
                "recorded_judge_count": judges,
                "recorded_specialist_count": specialists,
                "recorded_redeliberation_count": redeliberations,
                "spawned_ids_match_manifest": True,
                "completed_ids_match_record": True,
                "failed_wait_calls": 0,
                "successful_wait_calls": 0 if case_id == "low-routing" else 1,
                "followup_calls": 1 if case_id in {"high-adaptive", "injection-unverified", "critical-no-consensus"} else 0,
                "followup_attempts": 1 if case_id in {"high-adaptive", "injection-unverified", "critical-no-consensus"} else 0,
                "successful_followup_calls": 1 if case_id in {"high-adaptive", "injection-unverified", "critical-no-consensus"} else 0,
                "failed_followup_calls": 0,
                "fresh_judge_after_deliberation": stage in {"HIGH", "CRITICAL"},
                "fresh_judge_completed_after_spawn": stage in {"HIGH", "CRITICAL"},
                "reviewers_completed_before_cross": case_id in {"high-adaptive", "injection-unverified", "critical-no-consensus"},
                "cross_targets_match_record": case_id in {"high-adaptive", "injection-unverified", "critical-no-consensus"},
                "record_declared_roles_and_stages": True,
                "runtime_isolation_evidence": "NOT_OBSERVABLE",
                "hidden_system_prompt_evidence": "NOT_OBSERVABLE",
                "assurance": assurance,
                "consensus_status": consensus,
                "cross_examination_decision": cross,
                "has_nonverified_provenance": case_id == "injection-unverified",
                "nonverified_claims_linked_to_consensus": False,
                "critical_design_assurance_present": case_id == "critical-no-consensus",
                "no_consensus_complete": case_id == "critical-no-consensus",
            })
    if behavior_gate_errors(live, []):
        failures.append("complete synthetic behavior gate was rejected")
    if not behavior_gate_errors(live[:-1], []):
        failures.append("behavior gate accepted a missing run")
    if not behavior_gate_errors(live + [copy.deepcopy(live[0])], []):
        failures.append("behavior gate accepted a duplicate run")
    stale = copy.deepcopy(live)
    stale[0]["candidate_bundle_sha256"] = "0" * 64
    if not behavior_gate_errors(stale, []):
        failures.append("behavior gate accepted a stale candidate SHA")
    zero_workers = copy.deepcopy(live)
    for result in zero_workers:
        for key in ("actual_spawned_workers_count", "actual_completed_workers_count", "recorded_manifest_workers_count", "recorded_completed_workers_count", "recorded_reviewer_count", "recorded_judge_count", "recorded_specialist_count", "recorded_redeliberation_count"):
            result[key] = 0
    if not behavior_gate_errors(zero_workers, []):
        failures.append("behavior gate accepted zero-worker HIGH/CRITICAL attestations")
    return failures


def main() -> int:
    errors: list[str] = []
    skill = ROOT / "SKILL.md"
    schema_path = ROOT / "contracts" / "decision-record.v1.schema.json"
    requirements_path = ROOT / "contracts" / "requirements.json"
    try:
        skill_text = skill.read_text(encoding="utf-8")
        metadata = re.search(r"^metadata:\s*$(.*?)^---\s*$", skill_text, re.M | re.S)
        version_match = metadata and re.search(r'^\s*version:\s*["\']?(\d+\.\d+\.\d+)["\']?\s*$', metadata.group(1), re.M)
        if not version_match:
            errors.append("SKILL.md metadata must carry a semantic version")
        for target in re.findall(r"\]\((references/[^)#]+)", skill_text):
            if not (ROOT / target).is_file(): errors.append(f"SKILL.md reference target missing: {target}")
    except OSError as exc:
        errors.append(f"cannot read SKILL.md: {exc}")
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema" or schema.get("properties", {}).get("schema_version", {}).get("const") != "1.0":
            errors.append("decision-record schema is not a v1 Draft 2020-12 schema")
        def required_properties(node, label="$schema"):
            if isinstance(node, dict):
                if "properties" in node and set(node["properties"]) != set(node.get("required", [])):
                    errors.append(f"structured-output schema requires all properties at {label}")
                if "required" in node and len(node["required"]) != len(set(node["required"])):
                    errors.append(f"structured-output schema has duplicate required fields at {label}")
                if ("const" in node or "enum" in node) and "type" not in node:
                    errors.append(f"structured-output schema requires type for const/enum at {label}")
                types = node.get("type", [])
                if (types == "object" or isinstance(types, list) and "object" in types) and "properties" in node:
                    if node.get("additionalProperties") is not False or set(node.get("properties", {})) != set(node.get("required", [])):
                        errors.append(f"structured-output object is incomplete at {label}")
                for key, value in node.items(): required_properties(value, f"{label}.{key}")
            elif isinstance(node, list):
                for value in node: required_properties(value, label)
        required_properties(schema)
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load decision schema: {exc}")
    try:
        requirements = json.loads(requirements_path.read_text(encoding="utf-8"))["requirements"]
        ids = [entry.get("id") for entry in requirements]
        if len(requirements) != 24 or len(set(ids)) != 24 or any(not isinstance(i, str) or not i for i in ids):
            errors.append("requirements must contain exactly 24 unique stable IDs")
        categories = Counter(entry.get("category") for entry in requirements)
        if dict(categories) != EXPECTED:
            errors.append(f"requirement category counts differ: expected {EXPECTED}, got {dict(categories)}")
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        errors.append(f"cannot load requirements: {exc}")
    docs = [ROOT / "README.md", ROOT / "SKILL.md", *sorted((ROOT / "references").glob("*.md"))]
    for path in docs:
        try:
            text = path.read_text(encoding="utf-8")
            if re.search(r"\b(TODO|TBD|PLACEHOLDER)\b", text, re.I): errors.append(f"{path.relative_to(ROOT)} contains a placeholder")
            for target in re.findall(r"\]\((?!https?://|#)([^)#]+)", text):
                resolved = (path.parent / target).resolve()
                if not resolved.exists(): errors.append(f"broken relative link in {path.relative_to(ROOT)}: {target}")
        except (OSError, UnicodeDecodeError) as exc: errors.append(f"cannot UTF-8 decode {path.relative_to(ROOT)}: {exc}")
    valid = sorted((ROOT / "evals" / "fixtures" / "valid").glob("*.json"))
    invalid = sorted((ROOT / "evals" / "fixtures" / "invalid").glob("*.json"))
    if len(valid) != 24 or len(invalid) != 24:
        errors.append(f"expected 24 valid and 24 invalid fixtures, found {len(valid)} valid / {len(invalid)} invalid")
    if {path.name for path in valid} != {path.name for path in invalid}:
        errors.append("valid and invalid fixture names must match one-to-one")
    for path in valid:
        result = subprocess.run([sys.executable, str(VALIDATOR), str(path)], text=True, capture_output=True)
        if result.returncode != 0: errors.append(f"valid fixture rejected: {path.name}: {result.stderr.strip()}")
    for path in invalid:
        result = subprocess.run([sys.executable, str(VALIDATOR), str(path)], text=True, capture_output=True)
        if result.returncode == 0: errors.append(f"invalid fixture accepted: {path.name}")
        result_json = subprocess.run([sys.executable, str(VALIDATOR), str(path), "--json"], text=True, capture_output=True)
        try:
            payload = json.loads(result_json.stdout)
            issues = payload.get("issues", [])
            if not issues or any(issue.get("code") in {None, "contract.rule_violation", "validator.unmapped_error"} for issue in issues):
                errors.append(f"validator has missing or fallback error code: {path.name}")
        except (TypeError, json.JSONDecodeError): errors.append(f"cannot inspect validation code: {path.name}")
    errors.extend(regression_errors())
    errors.extend(evaluation_regression_errors())
    corpus = sorted((ROOT / "evals" / "corpus").glob("*.json"))
    if len(corpus) != 6: errors.append(f"expected 6 live scenarios, found {len(corpus)}")
    for path in corpus:
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            if not all(key in item for key in ("id", "stage", "decision", "expected_observations")):
                errors.append(f"scenario lacks required fields: {path.name}")
        except (OSError, json.JSONDecodeError) as exc: errors.append(f"cannot load scenario {path.name}: {exc}")
    if errors:
        print("PACKAGE INVALID", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print(f"PACKAGE VALID: 24 requirements, {len(valid)} valid fixtures, {len(invalid)} invalid fixtures, 20 semantic regressions, 6 evaluation-gate regressions, {len(corpus)} scenarios")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
