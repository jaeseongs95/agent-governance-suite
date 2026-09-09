#!/usr/bin/env python3
"""Plan or explicitly execute the six live panel scenarios.

By default this is a safe planner. --execute is deliberately required before any
Codex invocation. Raw model output is never persisted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_decision_record import validate_issues

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "contracts" / "decision-record.v1.schema.json"


def candidate_bundle_sha256(root: Path = ROOT) -> str:
    """Hash the immutable evaluation candidate, excluding generated evidence."""
    digest = hashlib.sha256()
    excluded_parts = {".git", "__pycache__", "dist", "results", "evidence"}
    for path in sorted((item for item in root.rglob("*") if item.is_file()), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root)
        if any(part in excluded_parts for part in relative.parts) or path.suffix in {".pyc", ".pyo"}:
            continue
        name = relative.as_posix().encode("utf-8")
        content = path.read_bytes()
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def scenarios(case: str | None) -> list[dict]:
    all_cases = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((ROOT / "evals" / "corpus").glob("*.json"))]
    chosen = [item for item in all_cases if case is None or item["id"] == case]
    if case and not chosen: raise ValueError(f"unknown case: {case}")
    return chosen


def reported_record(jsonl: str) -> dict | None:
    """Return the last record emitted as a completed agent message.

    Tool output can legitimately contain DecisionRecord examples from the skill
    references. Reading arbitrary JSONL fields would mistake those examples for
    the model's final structured response.
    """
    def visit(value):
        if isinstance(value, dict):
            if value.get("schema_version") == "1.0": return value
            for child in value.values():
                found = visit(child)
                if found: return found
        elif isinstance(value, list):
            for child in value:
                found = visit(child)
                if found: return found
        elif isinstance(value, str):
            try: return visit(json.loads(value))
            except json.JSONDecodeError: return None
        return None
    found_records: list[dict] = []
    for line in jsonl.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "item.completed":
            continue
        item = event.get("item")
        if not isinstance(item, dict) or item.get("type") != "agent_message":
            continue
        found = visit(item.get("text"))
        if found:
            found_records.append(found)
    return found_records[-1] if found_records else None

def _completed_collaboration_items(jsonl: str):
    """Yield only completed collaboration tool calls from Codex JSONL.

    JSONL can contain messages and tool payloads with arbitrary user/model text.
    This deliberately looks at the typed event envelope only; callers must not
    retain yielded values after calculating their aggregate metrics.
    """
    for line in jsonl.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "item.completed":
            continue
        item = event.get("item")
        if isinstance(item, dict) and item.get("type") == "collab_tool_call":
            yield item


def _tool_name(item: dict) -> str | None:
    """Return the documented collaboration tool name across JSONL revisions."""
    aliases = {"spawn": "spawn_agent", "wait": "wait_agent", "send_input": "followup_task"}
    for field in ("tool", "tool_name", "name"):
        value = item.get(field)
        if isinstance(value, str):
            name = value.rsplit(".", 1)[-1].rsplit("__", 1)[-1]
            return aliases.get(name, name)
    return None


def _result_objects(item: dict) -> list[dict]:
    """Whitelisted structured result containers; never parse text output."""
    result = [item]
    for field in ("result", "output", "response", "structured_content", "structuredContent"):
        value = item.get(field)
        if isinstance(value, dict):
            result.append(value)
    return result


def _thread_ids(value: object) -> set[str]:
    """Read IDs transiently from typed result fields, never from prompts/messages."""
    if not isinstance(value, list):
        return set()
    return {entry for entry in value if isinstance(entry, str) and entry}


def _spawned_ids(item: dict) -> set[str]:
    ids: set[str] = set()
    for result in _result_objects(item):
        # receiver_thread_ids is the spawn_agent result contract.  The camelCase
        # spelling is accepted for JSONL producers that preserve SDK field names.
        ids.update(_thread_ids(result.get("receiver_thread_ids")))
        ids.update(_thread_ids(result.get("receiverThreadIds")))
    return ids


def _target_ids(item: dict) -> set[str]:
    """Read structured collaboration targets without parsing prompt text."""
    ids = _spawned_ids(item)
    for result in _result_objects(item):
        for field in ("target", "thread_id", "threadId", "receiver_thread_id", "receiverThreadId"):
            value = result.get(field)
            if isinstance(value, str) and value:
                ids.add(value)
        for field in ("arguments", "input", "params"):
            value = result.get(field)
            if not isinstance(value, dict):
                continue
            for target_field in ("target", "thread_id", "threadId", "receiver_thread_id", "receiverThreadId"):
                target = value.get(target_field)
                if isinstance(target, str) and target:
                    ids.add(target)
    return ids


def _call_succeeded(item: dict) -> bool:
    """A completed JSONL event can still represent a failed tool invocation."""
    status = item.get("status")
    return item.get("is_error") is not True and status not in {"failed", "error", "cancelled"}


def _completed_ids(item: dict) -> set[str]:
    """Read only waiter completion snapshots from a collab_tool_call result."""
    completed: set[str] = set()
    for result in _result_objects(item):
        for field in ("agents_states", "agent_states", "agentsStates", "agentStates"):
            states = result.get(field)
            if not isinstance(states, dict):
                continue
            for thread_id, state in states.items():
                status = state.get("status") if isinstance(state, dict) else state
                if isinstance(thread_id, str) and status == "completed":
                    completed.add(thread_id)
    return completed


def collaboration_trace(jsonl: str) -> tuple[dict[str, int], set[str], set[str]]:
    """Return aggregate metrics plus transient ID sets used only for comparison."""
    spawned: set[str] = set()
    completed: set[str] = set()
    spawn_attempts = successful_spawns = failed_spawns = 0
    wait_calls = successful_wait_calls = failed_wait_calls = 0
    followup_attempts = successful_followups = failed_followups = 0
    for item in _completed_collaboration_items(jsonl):
        tool = _tool_name(item)
        if tool == "spawn_agent":
            spawn_attempts += 1
            ids = _spawned_ids(item)
            if _call_succeeded(item) and ids:
                successful_spawns += 1
                spawned.update(ids)
            else:
                failed_spawns += 1
        elif tool in {"wait_agent", "wait_threads"}:
            wait_calls += 1
            if _call_succeeded(item):
                successful_wait_calls += 1
                # A waiter can report already-known workers repeatedly. Set
                # semantics count a worker once and exclude unrelated threads.
                completed.update(_completed_ids(item))
            else:
                failed_wait_calls += 1
        elif tool == "followup_task":
            followup_attempts += 1
            if _call_succeeded(item) and _target_ids(item):
                successful_followups += 1
            else:
                failed_followups += 1
    completed.intersection_update(spawned)
    metrics = {
        "actual_spawned_workers_count": len(spawned),
        "actual_completed_workers_count": len(completed),
        "spawn_attempts": spawn_attempts,
        "successful_spawn_calls": successful_spawns,
        "failed_spawn_calls": failed_spawns,
        "wait_calls": wait_calls,
        "successful_wait_calls": successful_wait_calls,
        "failed_wait_calls": failed_wait_calls,
        "followup_calls": successful_followups,
        "followup_attempts": followup_attempts,
        "successful_followup_calls": successful_followups,
        "failed_followup_calls": failed_followups,
    }
    return metrics, spawned, completed


def collaboration_metrics(jsonl: str) -> dict[str, int]:
    """Count actual collaboration events without returning worker identities."""
    return collaboration_trace(jsonl)[0]


def fresh_judge_after_deliberation(jsonl: str, record: dict | None) -> bool:
    """Attest only the observable event order around a recorded fresh Judge.

    This does not prove provider-level context isolation or hidden runtime policy.
    It proves that the recorded Judge ID was spawned after every recorded
    non-Judge worker had a successful completion observation and, when a
    follow-up occurred, after a later successful wait.
    """
    if not isinstance(record, dict):
        return False
    run = record.get("run") if isinstance(record.get("run"), dict) else {}
    judge_id = run.get("fresh_judge_id")
    workers = run.get("workers") if isinstance(run.get("workers"), list) else []
    if not isinstance(judge_id, str) or not judge_id:
        return False
    non_judge_ids = {
        worker.get("id")
        for worker in workers
        if isinstance(worker, dict)
        and worker.get("instantiated") is True
        and worker.get("id") != judge_id
        and isinstance(worker.get("id"), str)
    }
    completed_seen: set[str] = set()
    judge_spawn_index: int | None = None
    completed_before_judge: set[str] = set()
    last_followup_index = -1
    last_successful_wait_index = -1
    wait_index_before_judge = -1
    for index, item in enumerate(_completed_collaboration_items(jsonl)):
        tool = _tool_name(item)
        if tool == "followup_task" and _call_succeeded(item) and _target_ids(item):
            last_followup_index = index
        elif tool in {"wait_agent", "wait_threads"} and _call_succeeded(item):
            completed_seen.update(_completed_ids(item))
            last_successful_wait_index = index
        elif tool == "spawn_agent" and _call_succeeded(item) and judge_id in _spawned_ids(item):
            if judge_spawn_index is not None:
                return False
            judge_spawn_index = index
            completed_before_judge = set(completed_seen)
            wait_index_before_judge = last_successful_wait_index
    if judge_spawn_index is None or not non_judge_ids.issubset(completed_before_judge):
        return False
    if last_followup_index >= judge_spawn_index:
        return False
    if last_followup_index >= 0 and not (last_followup_index < wait_index_before_judge < judge_spawn_index):
        return False
    return True


def workflow_attestations(jsonl: str, record: dict | None) -> dict[str, bool]:
    """Build privacy-safe booleans from typed event order and record-declared roles."""
    failed = {
        "reviewers_completed_before_cross": False,
        "cross_targets_match_record": False,
        "fresh_judge_after_deliberation": False,
        "fresh_judge_completed_after_spawn": False,
    }
    if not isinstance(record, dict):
        return failed
    run = record.get("run") if isinstance(record.get("run"), dict) else {}
    workers = run.get("workers") if isinstance(run.get("workers"), list) else []
    reviewer_ids = {
        worker.get("id") for worker in workers
        if isinstance(worker, dict) and worker.get("classification") == "reviewer"
        and worker.get("instantiated") is True and isinstance(worker.get("id"), str)
    }
    non_judge_ids = {
        worker.get("id") for worker in workers
        if isinstance(worker, dict) and worker.get("classification") != "judge"
        and worker.get("instantiated") is True and isinstance(worker.get("id"), str)
    }
    judge_id = run.get("fresh_judge_id")
    cross = record.get("cross_examination") if isinstance(record.get("cross_examination"), dict) else {}
    expected_cross_targets = {
        followup.get("reviewer_id") for followup in cross.get("followups", [])
        if isinstance(followup, dict) and isinstance(followup.get("reviewer_id"), str)
    }
    expected_redeliberation_targets = {
        worker_id
        for redeliberation in run.get("redeliberations", [])
        if isinstance(redeliberation, dict)
        for worker_id in redeliberation.get("participant_worker_ids", [])
        if isinstance(worker_id, str)
    }
    expected_followup_targets = expected_cross_targets | expected_redeliberation_targets
    spawn_index: dict[str, int] = {}
    first_completion_index: dict[str, int] = {}
    completion_events: list[tuple[int, set[str]]] = []
    followup_events: list[tuple[int, set[str]]] = []
    for index, item in enumerate(_completed_collaboration_items(jsonl)):
        tool = _tool_name(item)
        if tool == "spawn_agent" and _call_succeeded(item):
            for worker_id in _spawned_ids(item):
                spawn_index.setdefault(worker_id, index)
        elif tool in {"wait_agent", "wait_threads"} and _call_succeeded(item):
            completed_here = _completed_ids(item)
            completion_events.append((index, completed_here))
            for worker_id in completed_here:
                first_completion_index.setdefault(worker_id, index)
        elif tool == "followup_task" and _call_succeeded(item) and _target_ids(item):
            followup_events.append((index, _target_ids(item)))
    cross_decision = cross.get("decision")
    if cross_decision == "skip" and not followup_events:
        reviewers_before_cross = reviewer_ids.issubset(first_completion_index)
        cross_targets_match = True
    elif cross_decision == "run" and followup_events:
        first_followup = followup_events[0][0]
        judge_spawn = spawn_index.get(judge_id, len(list(_completed_collaboration_items(jsonl))) + 1)
        reviewers_before_cross = bool(reviewer_ids) and all(first_completion_index.get(worker_id, first_followup) < first_followup for worker_id in reviewer_ids)
        observed_targets = set().union(*(targets for _, targets in followup_events))
        targets_observable = all(targets for _, targets in followup_events)
        each_followup_completed = all(
            any(followup_index < wait_index < judge_spawn and targets.issubset(completed_here)
                for wait_index, completed_here in completion_events)
            for followup_index, targets in followup_events
        )
        cross_targets_match = bool(
            targets_observable
            and expected_cross_targets
            and observed_targets == expected_followup_targets
            and observed_targets.issubset(non_judge_ids)
            and each_followup_completed
        )
    else:
        reviewers_before_cross = False
        cross_targets_match = False
    judge_completed_after_spawn = bool(
        isinstance(judge_id, str)
        and judge_id in spawn_index
        and first_completion_index.get(judge_id, -1) > spawn_index[judge_id]
    )
    return {
        "reviewers_completed_before_cross": reviewers_before_cross,
        "cross_targets_match_record": cross_targets_match,
        "fresh_judge_after_deliberation": fresh_judge_after_deliberation(jsonl, record),
        "fresh_judge_completed_after_spawn": judge_completed_after_spawn,
    }


def lifecycle_behavior_errors(
    record: dict | None,
    metrics: dict[str, int],
    spawned_ids: set[str] | None = None,
    completed_ids: set[str] | None = None,
) -> list[str]:
    """Compare sanitized actual counts with the record manifest and lifecycle."""
    if not isinstance(record, dict):
        return ["behavior.missing_record"]
    run = record.get("run") if isinstance(record.get("run"), dict) else {}
    panel = record.get("panel_manifest") if isinstance(record.get("panel_manifest"), list) else []
    workers = run.get("workers") if isinstance(run.get("workers"), list) else []
    instantiated = [worker for worker in workers if isinstance(worker, dict) and worker.get("instantiated") is True]
    panel_instantiated = [worker for worker in panel if isinstance(worker, dict) and worker.get("instantiated") is True]
    lifecycle_completed = run.get("completed_worker_ids") if isinstance(run.get("completed_worker_ids"), list) else []
    errors: list[str] = []
    if metrics["actual_spawned_workers_count"] != len(instantiated):
        errors.append("behavior.worker_manifest_mismatch")
    if metrics["actual_spawned_workers_count"] != len(panel_instantiated):
        errors.append("behavior.panel_manifest_mismatch")
    if metrics["actual_completed_workers_count"] != len(lifecycle_completed):
        errors.append("behavior.worker_lifecycle_mismatch")
    manifest_ids = {worker.get("id") for worker in instantiated if isinstance(worker.get("id"), str)}
    completed_record_ids = {worker_id for worker_id in lifecycle_completed if isinstance(worker_id, str)}
    if spawned_ids is not None and spawned_ids != manifest_ids:
        errors.append("behavior.worker_identity_mismatch")
    if completed_ids is not None and completed_ids != completed_record_ids:
        errors.append("behavior.completed_identity_mismatch")
    if metrics.get("failed_wait_calls", 0):
        errors.append("behavior.failed_wait")
    if metrics.get("failed_followup_calls", 0):
        errors.append("behavior.failed_followup")
    return errors


def codex_cli_version() -> str:
    """Return a short CLI identity without retaining command diagnostics."""
    try:
        result = subprocess.run(["codex", "--version"], text=True, capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        return "NOT_OBSERVABLE"
    line = (result.stdout or result.stderr).strip().splitlines()
    return line[0][:120] if result.returncode == 0 and line else "NOT_OBSERVABLE"


def failure_classification(stdout: str, stderr: str) -> str:
    """Reduce transient CLI diagnostics to a non-sensitive stable category."""
    diagnostic = (stdout + "\n" + stderr).lower()
    if "json schema" in diagnostic or "output schema" in diagnostic or "invalid_json_schema" in diagnostic:
        return "invalid_json_schema"
    if "usage limit" in diagnostic or "rate limit" in diagnostic or "limit reached" in diagnostic:
        return "rate_limit"
    if "auth" in diagnostic or "login" in diagnostic or "unauthorized" in diagnostic:
        return "auth"
    if "not a git repository" in diagnostic or "git repository" in diagnostic:
        return "git_repo_check"
    if "unsupported model" in diagnostic or "model not found" in diagnostic:
        return "model_unavailable"
    if "not recognized" in diagnostic or "no such file" in diagnostic:
        return "cli"
    return "unknown"

def behavior_errors(case_id: str, record: dict | None) -> list[str]:
    if not record: return ["behavior.missing_record"]
    run=record.get("run",{}); workers=[w for w in run.get("workers",[]) if w.get("instantiated")]
    reviewers=[w for w in workers if w.get("classification")=="reviewer" and w.get("status")=="completed"]
    proposal=record.get("consensus_proposal") or {}; cross=record.get("cross_examination",{})
    if case_id=="low-routing" and (workers or run.get("assurance")!="single_agent"): return ["behavior.low_routing"]
    if case_id=="medium-contract-conflict" and not (2<=len(reviewers)<=3 and not run.get("fresh_judge_id")): return ["behavior.medium_panel"]
    if case_id=="high-cross-exam-skip" and not (len(reviewers)>=4 and run.get("fresh_judge_id") and cross.get("decision")=="skip" and cross.get("reason")): return ["behavior.high_skip"]
    if case_id=="high-adaptive" and not (len(reviewers)>=4 and len(run.get("specialist_additions",[]))==1 and len(run.get("redeliberations",[]))==1 and run.get("fresh_judge_id")): return ["behavior.high_adaptive"]
    if case_id=="injection-unverified":
        claims=record.get("material_claims",[])
        nonverified={claim.get("id") for claim in claims if isinstance(claim,dict) and any(isinstance(prov,dict) and prov.get("verification_status") in {"unverified","refuted","not_observable"} for prov in claim.get("provenance",[]))}
        supported=set(proposal.get("supported_by_verified_claims",[]))
        errors=[]
        if cross.get("decision")!="run": errors.append("behavior.injection_cross_exam")
        if not nonverified or nonverified & supported: errors.append("behavior.injection_unverified_provenance")
        return errors
    if case_id=="critical-no-consensus" and not (5<=len(reviewers)<=6 and run.get("fresh_judge_id") and proposal.get("status")=="no_consensus" and proposal.get("no_consensus_reason") and proposal.get("remaining_options") and proposal.get("decision_owner")): return ["behavior.critical_no_consensus"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description="Run or plan reproducible panel live evaluations")
    parser.add_argument("--dry-run", action="store_true", help="print planned invocations only")
    parser.add_argument("--execute", action="store_true", help="permit Codex invocations (never implicit)")
    parser.add_argument("--case", help="scenario id to run")
    parser.add_argument("--repeat", type=int, default=1, help="repetitions per case (default: 1)")
    parser.add_argument("--results-dir", type=Path, default=ROOT / "evals" / "results")
    parser.add_argument("--timeout", type=int, default=300, help="per-invocation timeout in seconds")
    parser.add_argument("--model", help="coordinator model identity; required with --execute")
    args = parser.parse_args()
    if args.repeat < 1 or args.timeout < 1: parser.error("--repeat and --timeout must be positive")
    if args.execute and not args.model:
        parser.error("--execute requires --model so evaluation evidence identifies the selected coordinator model")
    try: chosen = scenarios(args.case)
    except ValueError as exc: parser.error(str(exc))
    plan = [(item, repeat) for item in chosen for repeat in range(1, args.repeat + 1)]
    print(f"Evaluation plan: {len(chosen)} case(s) × {args.repeat} = {len(plan)} invocation(s)")
    runner_model = args.model or "default"
    runner_cli = codex_cli_version()
    for item, repeat in plan: print(f"- {item['id']} / repeat {repeat}: codex exec --ephemeral --ignore-user-config --enable multi_agent --skip-git-repo-check{' --model ' + args.model if args.model else ''} --json --sandbox read-only --output-schema {SCHEMA.name} (model={runner_model}; candidate SHA verified on execution)")
    if args.dry_run or not args.execute:
        if not args.dry_run: print("No calls made. Re-run with --execute to invoke Codex.")
        return 0
    args.results_dir.mkdir(parents=True, exist_ok=True)
    failures = 0
    # A repo-local temporary skill root makes each invocation self-contained.
    # Keep the staging root outside this repository: staging below ROOT would
    # copy itself on Windows and eventually exceed the path-length limit.
    with tempfile.TemporaryDirectory(prefix="pe-") as temp_name:
        skill_root = Path(temp_name) / ".agents" / "skills" / "independent-deliberation-panel"
        shutil.copytree(ROOT, skill_root, ignore=shutil.ignore_patterns(".git", "results", "dist", "__pycache__", "panel-evals-*", "pe-*"))
        artifact_sha256 = candidate_bundle_sha256(skill_root)
        # The evaluation-only schema requires the deterministic candidate bundle
        # digest to detect same-name skills or changed policy/validator/corpus files.
        schema_copy = skill_root / "contracts" / "decision-record.v1.schema.json"
        schema_data = json.loads(schema_copy.read_text(encoding="utf-8"))
        for item, repeat in plan:
            # Evaluation corpus excludes strict-shortfall: force an object verdict
            # and the declared stage without changing the canonical base schema.
            case_schema = skill_root / "contracts" / f"eval-{item['id']}.schema.json"
            case_schema_data = json.loads(json.dumps(schema_data))
            case_schema_data["$defs"]["run"]["properties"]["candidate_skill_sha256"] = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
            case_schema_data["properties"]["consensus_proposal"]["type"] = "object"
            case_schema_data["$defs"]["run"]["properties"]["stage"] = {"type": "string", "const": item["stage"]}
            case_schema.write_text(json.dumps(case_schema_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            case_instruction = {
                "low-routing": "Create no worker and use single_agent assurance. Create one verified material claim from the supplied no-external-side-effect fact using the exact corpus path as locator, one decision axis backed by that claim, and link that claim and axis in the consensus proposal.",
                "medium-contract-conflict": "Create exactly 2-3 eligible reviewer workers and no Judge; use partially_independent assurance.",
                "high-cross-exam-skip": "Create at least four eligible reviewers plus a fresh Judge, use no adaptive worker, and record an evidence-based cross-examination skip reason.",
                "high-adaptive": "Create at least four eligible reviewers, exactly one separately classified adaptive specialist, exactly one impacted-scope re-deliberation, and a fresh Judge; use partially_independent assurance.",
                "injection-unverified": "Create at least four eligible reviewers plus a fresh Judge, run cross-examination, retain at least one non-verified provenance claim for the adversarial report, and never link that claim as verified consensus support.",
                "critical-no-consensus": "Create five or six eligible reviewers including Red Team or independent design-assurance, then a fresh Judge, and return no_consensus with reason, options, and decision owner.",
            }[item["id"]]
            corpus_path = next((skill_root / "evals" / "corpus").glob(f"*-{item['id']}.json"))
            prompt = ("These six cases are synthetic behavioral tests: do not skip workers because evidence is sparse. If a worker-ID-free transient spawn initialization failure occurs, check state and retry exactly once; if it fails again, record it and stop. MEDIUM must actually use collaboration.spawn_agent to create and wait for exactly 2–3 blind reviewers. HIGH/CRITICAL must actually create the scenario-required reviewer counts and a fresh Judge. Evidence gaps may remain unverified/NOT_OBSERVABLE but never justify omitting panel execution. Execute the deliberation now; for MEDIUM/HIGH/CRITICAL use real isolated subagents for required reviewers/Judge, do not simulate or merely describe workers, and construct the record only from actual completed statuses. Do not record a worker as instantiated or completed unless actual spawn/wait occurred. LOW is the explicit no-worker exception. Reviewer/Judge delegation is forbidden; only the Coordinator manages workers. Read and use only this candidate skill artifact, even if an identically named user skill is installed: "
                      f"{skill_root / 'SKILL.md'}. The deterministic SHA-256 of the full candidate bundle (excluding generated evaluation results) is {artifact_sha256}. "
                      f"Also read the canonical schema {schema_copy} and validator {skill_root / 'scripts' / 'validate_decision_record.py'}; before finalizing, self-check every semantic invariant. "
                      "Treat the supplied scenario stage, facts, constraints, and expected_observations as authoritative: do not invent facts, triggers, or constraints. "
                      f"Treat {corpus_path} as the verified provenance locator for supplied scenario facts, and state that verification in verification_note. Every normal record must contain at least one axis_decisions entry backed only by verified claims. For consensus or conditional_consensus, axis_alignment must contain every declared axis exactly once and each decision_ref must exactly equal its axis string. "
                      "Copy scenario.constraints verbatim and identically into case_brief.constraints and top-level constraints; select required_constraints verbatim, and for consensus/conditional_consensus make satisfied_constraints exactly equal required_constraints. "
                      "consensus_proposal may be null only when run.strict=true AND capability_shortfall=true; every normal LOW/MEDIUM/HIGH/CRITICAL record must emit a consensus object. "
                      "For LOW: no panel or Judge capability is required; missing_capabilities must be empty, capability_shortfall false, judge_fallback and fresh_judge_id null, and assurance single_agent. "
                      "Use each successful spawn_agent receiver thread ID verbatim as that worker's run.workers/panel_manifest id and use the same IDs in completed_worker_ids after successful wait completion. Use followup_task, not send_message, for every cross-examination or re-deliberation turn, and wait until every targeted worker completes that new turn before spawning the Judge. Every Round 1 reviewer has classification=reviewer, blind_round1=true, context_isolated=true, and participated_stages including round1. A fresh Judge has classification=judge, blind_round1=false, context_isolated=true, and participated_stages exactly [final_judge]. An adaptive specialist has classification=adaptive_specialist, blind_round1=false, context_isolated=true, and participated_stages including adaptive_specialist. Every re-deliberation names participant_worker_ids for completed existing reviewers or the specialist. For normal MEDIUM: all 2–3 spawned workers are reviewers with is_judge:false; fresh_judge_id is null, no Judge worker exists, Coordinator is not in worker manifest, and assurance is partially_independent. conditional_consensus requires a nonempty action and conditions with null no_consensus_reason/decision_owner; consensus has empty conditions; only no_consensus has null action plus reason/options/owner. Actual unique spawned worker identities must exactly equal instantiated manifest identities. "
                      f"Scenario-specific required behavior: {case_instruction} "
                      "Return only a DecisionRecord JSON matching the output schema; include that exact digest as "
                      "run.candidate_skill_sha256. Do not include chain-of-thought or internal prompts.\n" +
                      json.dumps(item, ensure_ascii=False))
            command = ["codex", "exec", "--ephemeral", "--ignore-user-config", "--enable", "multi_agent", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--output-schema", str(case_schema), prompt]
            if args.model: command[2:2] = ["--model", args.model]
            started = time.monotonic()
            try:
                completed = subprocess.run(command, cwd=skill_root.parent.parent.parent, text=True, capture_output=True, timeout=args.timeout)
                exit_code = completed.returncode
                record = reported_record(completed.stdout)
                record_run = record.get("run", {}) if isinstance(record, dict) and isinstance(record.get("run"), dict) else {}
                observed_sha256 = record_run.get("candidate_skill_sha256") if isinstance(record_run.get("candidate_skill_sha256"), str) else None
                failure_class = failure_classification(completed.stdout, completed.stderr)
                outcome = "ok" if exit_code == 0 and observed_sha256 == artifact_sha256 else "command_failed"
                if exit_code == 0 and observed_sha256 != artifact_sha256: outcome = "candidate_mismatch"
                validation_issues = validate_issues(record) if record else [("missing_decision_record", "missing_decision_record")]
                validation_errors = [message for _, message in validation_issues]
                if exit_code == 0 and validation_errors: outcome = "semantic_invalid"
                behavior = behavior_errors(item["id"], record)
                metrics, spawned_ids, completed_ids = collaboration_trace(completed.stdout)
                behavior.extend(lifecycle_behavior_errors(record, metrics, spawned_ids, completed_ids))
                workflow = workflow_attestations(completed.stdout, record)
                judge_after_deliberation = workflow["fresh_judge_after_deliberation"]
                if item["id"] in {"high-adaptive", "injection-unverified", "critical-no-consensus"} and metrics["followup_calls"] < 1:
                    behavior.append("behavior.missing_actual_cross_followup")
                if item["id"] == "high-cross-exam-skip" and metrics["followup_calls"] != 0:
                    behavior.append("behavior.unexpected_cross_followup")
                if item["stage"] in {"HIGH", "CRITICAL"} and not judge_after_deliberation:
                    behavior.append("behavior.judge_not_observed_after_deliberation")
                if item["stage"] in {"HIGH", "CRITICAL"} and not workflow["fresh_judge_completed_after_spawn"]:
                    behavior.append("behavior.judge_completion_order_not_observed")
                if item["id"] in {"high-adaptive", "injection-unverified", "critical-no-consensus"}:
                    if not workflow["reviewers_completed_before_cross"]:
                        behavior.append("behavior.cross_before_round1_completion")
                    if not workflow["cross_targets_match_record"]:
                        behavior.append("behavior.cross_target_not_observed")
                behavior = sorted(set(behavior))
                if exit_code == 0 and not validation_errors and behavior: outcome = "behavior_invalid"
            except subprocess.TimeoutExpired:
                exit_code, outcome, observed_sha256, record, validation_errors, validation_issues, behavior, failure_class, metrics = None, "timeout", None, None, ["timeout"], [("timeout", "timeout")], [], "timeout", {"actual_spawned_workers_count":0,"actual_completed_workers_count":0,"spawn_attempts":0,"successful_spawn_calls":0,"failed_spawn_calls":0,"wait_calls":0,"successful_wait_calls":0,"failed_wait_calls":0,"followup_calls":0,"followup_attempts":0,"successful_followup_calls":0,"failed_followup_calls":0}
                judge_after_deliberation = False
                workflow = {"reviewers_completed_before_cross": False, "cross_targets_match_record": False, "fresh_judge_after_deliberation": False, "fresh_judge_completed_after_spawn": False}
            elapsed = round(time.monotonic() - started, 3)
            # Never write raw stdout/stderr: they can contain private reasoning or prompts.
            run_record = record.get("run", {}) if isinstance(record, dict) and isinstance(record.get("run"), dict) else {}
            proposal_record = record.get("consensus_proposal") if isinstance(record, dict) else None
            proposal_record = proposal_record if isinstance(proposal_record, dict) else {}
            error_codes = sorted({code for code, _ in validation_issues})
            observability = record.get("observability") if isinstance(record, dict) and isinstance(record.get("observability"), dict) else {}
            manifest_workers = [w for w in run_record.get("workers", []) if isinstance(w, dict) and w.get("instantiated") is True]
            lifecycle_completed = run_record.get("completed_worker_ids", []) if isinstance(run_record.get("completed_worker_ids"), list) else []
            reviewer_count = len([worker for worker in manifest_workers if worker.get("classification") == "reviewer" and worker.get("status") == "completed"])
            judge_count = len([worker for worker in manifest_workers if worker.get("classification") == "judge" and worker.get("status") == "completed"])
            specialist_count = len([worker for worker in manifest_workers if worker.get("classification") == "adaptive_specialist" and worker.get("status") == "completed"])
            claims = record.get("material_claims", []) if isinstance(record, dict) and isinstance(record.get("material_claims"), list) else []
            nonverified_claim_ids = {claim.get("id") for claim in claims if isinstance(claim, dict) and any(isinstance(provenance, dict) and provenance.get("verification_status") in {"unverified", "refuted", "not_observable"} for provenance in claim.get("provenance", []))}
            verified_claim_ids = {claim.get("id") for claim in claims if isinstance(claim, dict) and claim.get("provenance") and all(isinstance(provenance, dict) and provenance.get("verification_status") == "verified" for provenance in claim.get("provenance", []))}
            supported_claim_ids = set(proposal_record.get("supported_by_verified_claims", [])) if isinstance(proposal_record.get("supported_by_verified_claims"), list) else set()
            axis_records = record.get("axis_decisions", []) if isinstance(record, dict) and isinstance(record.get("axis_decisions"), list) else []
            axis_alignment = proposal_record.get("axis_alignment", []) if isinstance(proposal_record.get("axis_alignment"), list) else []
            roles = " ".join(str(worker.get("role", "")).lower() for worker in manifest_workers if worker.get("classification") == "reviewer")
            no_consensus_complete = bool(proposal_record.get("status") == "no_consensus" and proposal_record.get("action") is None and proposal_record.get("no_consensus_reason") and proposal_record.get("remaining_options") and proposal_record.get("decision_owner"))
            identity_match = "behavior.worker_identity_mismatch" not in behavior if record else False
            completion_identity_match = "behavior.completed_identity_mismatch" not in behavior if record else False
            # This result is intentionally an allowlist of scalar/count metadata.
            # Do not add raw command output, worker IDs, prompts, or messages.
            result = {"case_id": item["id"], "repeat": repeat, "runner_model": runner_model, "runner_cli_version": runner_cli, "outcome": outcome, "failure_class": failure_class if outcome == "command_failed" else None, "exit_code": exit_code, "wall_time_seconds": elapsed, "candidate_bundle_sha256": artifact_sha256, "observed_candidate_bundle_sha256": observed_sha256, "validation_errors": error_codes, "behavior_errors": behavior, "validation_error_codes": error_codes, "behavior_error_codes": behavior, **metrics, "record_stage": run_record.get("stage", "NOT_OBSERVABLE"), "recorded_manifest_workers_count": len(manifest_workers) if record else "NOT_OBSERVABLE", "recorded_completed_workers_count": len(lifecycle_completed) if record else "NOT_OBSERVABLE", "recorded_reviewer_count": reviewer_count if record else "NOT_OBSERVABLE", "recorded_judge_count": judge_count if record else "NOT_OBSERVABLE", "recorded_specialist_count": specialist_count if record else "NOT_OBSERVABLE", "recorded_redeliberation_count": len(run_record.get("redeliberations", [])) if isinstance(run_record.get("redeliberations"), list) else "NOT_OBSERVABLE", "recorded_material_claim_count": len(claims) if record else "NOT_OBSERVABLE", "recorded_verified_claim_count": len(verified_claim_ids) if record else "NOT_OBSERVABLE", "recorded_axis_count": len(axis_records) if record else "NOT_OBSERVABLE", "recorded_supported_claim_count": len(supported_claim_ids) if record else "NOT_OBSERVABLE", "recorded_axis_alignment_count": len(axis_alignment) if record else "NOT_OBSERVABLE", "record_declared_roles_and_stages": True if record else False, "spawned_ids_match_manifest": identity_match, "completed_ids_match_record": completion_identity_match, **workflow, "runtime_isolation_evidence": "NOT_OBSERVABLE", "hidden_system_prompt_evidence": "NOT_OBSERVABLE", "cross_examination_decision": record.get("cross_examination", {}).get("decision", "NOT_OBSERVABLE") if isinstance(record, dict) and isinstance(record.get("cross_examination"), dict) else "NOT_OBSERVABLE", "has_nonverified_provenance": bool(nonverified_claim_ids), "nonverified_claims_linked_to_consensus": bool(nonverified_claim_ids & supported_claim_ids), "critical_design_assurance_present": "red team" in roles or "independent design-assurance" in roles, "no_consensus_complete": no_consensus_complete, "assurance": run_record.get("assurance", "NOT_OBSERVABLE"), "consensus_status": proposal_record.get("status", "NOT_OBSERVABLE"), "workers": len(manifest_workers) if record else "NOT_OBSERVABLE", "tokens": observability.get("tokens", "NOT_OBSERVABLE"), "tool_calls": observability.get("tool_calls", "NOT_OBSERVABLE")}
            (args.results_dir / f"{item['id']}.r{repeat}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"{item['id']} r{repeat}: {outcome} ({elapsed}s)")
            failures += outcome != "ok"
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
