#!/usr/bin/env python3
"""Validate a DecisionRecord v1 without third-party dependencies.

The JSON Schema is supplied to Codex for generation; this validator deliberately
enforces the cross-field semantics that JSON Schema cannot conveniently express.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


STATUSES = {"verified", "unverified", "refuted", "not_observable"}
STAGES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
SCHEMA = json.loads((Path(__file__).resolve().parents[1] / "contracts" / "decision-record.v1.schema.json").read_text(encoding="utf-8"))

def schema_errors(value: Any, schema: dict[str, Any] | None = None, path: str = "$") -> list[str]:
    """Small Draft-2020 subset: enough to make contract structure executable."""
    schema = schema or SCHEMA; errors: list[str] = []
    if "anyOf" in schema:
        return [] if any(not schema_errors(value, option, path) for option in schema["anyOf"]) else [f"{path} violates schema anyOf"]
    if "$ref" in schema: return schema_errors(value, SCHEMA["$defs"][schema["$ref"].rsplit("/", 1)[-1]], path)
    types = schema.get("type"); allowed = types if isinstance(types, list) else [types]
    kind = {"object":dict,"array":list,"string":str,"integer":int,"number":(int,float),"boolean":bool,"null":type(None)}
    if types and not any(isinstance(value, kind[t]) and not (t in {"integer","number"} and isinstance(value,bool)) for t in allowed): return [f"{path} violates schema type"]
    if "const" in schema and value != schema["const"]: errors.append(f"{path} violates schema const")
    if "enum" in schema and value not in schema["enum"]: errors.append(f"{path} violates schema enum")
    if isinstance(value, dict):
        for key in schema.get("required", []):
            if key not in value: errors.append(f"{path} missing schema-required {key}")
        props=schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props: errors.append(f"{path}.{key} is an unknown schema property")
        for key, child in value.items():
            if key in props: errors += schema_errors(child, props[key], f"{path}.{key}")
    elif isinstance(value,list):
        if len(value) < schema.get("minItems",0): errors.append(f"{path} violates schema minItems")
        if "maxItems" in schema and len(value)>schema["maxItems"]: errors.append(f"{path} violates schema maxItems")
        if "items" in schema:
            for i, child in enumerate(value): errors += schema_errors(child, schema["items"], f"{path}[{i}]")
    elif isinstance(value,str):
        if schema.get("minLength",0)>len(value): errors.append(f"{path} violates schema minLength")
        if schema.get("pattern") and re.fullmatch(schema["pattern"], value) is None: errors.append(f"{path} violates schema pattern")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]: errors.append(f"{path} violates schema minimum")
        if "maximum" in schema and value > schema["maximum"]: errors.append(f"{path} violates schema maximum")
    return errors


def _list(value: Any, path: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        errors.append(f"{path} must be an array")
        return []
    return value


def _obj(value: Any, path: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{path} must be an object")
        return {}
    return value


def _required(obj: dict[str, Any], keys: set[str], path: str, errors: list[str]) -> None:
    missing = sorted(keys - obj.keys())
    if missing:
        errors.append(f"{path} missing required field(s): {', '.join(missing)}")


def validate(record: Any) -> list[str]:
    errors: list[str] = schema_errors(record)
    root = _obj(record, "$", errors)
    _required(root, {"skill_version", "preflight", "schema_version", "case_brief", "run", "panel_manifest", "constraints", "required_constraints", "material_claims", "cross_examination", "issue_ledger", "axis_decisions", "consensus_proposal", "observability"}, "$", errors)
    if root.get("schema_version") != "1.0":
        errors.append("schema_version must be '1.0'")
    if root.get("skill_version") != "1.0.0": errors.append("skill_version must be 1.0.0")
    preflight = _obj(root.get("preflight"), "preflight", errors)
    _required(preflight, {"required_capabilities","observed_capabilities","missing_capabilities","supported_models_reasoning"}, "preflight", errors)
    required_capabilities = _list(preflight.get("required_capabilities"), "preflight.required_capabilities", errors)
    observed_capabilities = _list(preflight.get("observed_capabilities"), "preflight.observed_capabilities", errors)
    missing_capabilities = _list(preflight.get("missing_capabilities"), "preflight.missing_capabilities", errors)
    for label, values in (
        ("required", required_capabilities),
        ("observed", observed_capabilities),
        ("missing", missing_capabilities),
    ):
        if (not all(isinstance(value, str) and value.strip() for value in values)
                or len(values) != len(set(values))):
            errors.append(f"preflight {label} capabilities must be unique nonempty strings")
    required_set = set(required_capabilities)
    observed_set = set(observed_capabilities)
    missing_set = set(missing_capabilities)
    if missing_set != required_set - observed_set:
        errors.append("preflight missing capabilities must exactly equal required minus observed capabilities")

    brief = _obj(root.get("case_brief"), "case_brief", errors)
    _required(brief, {"decision", "facts", "assumptions", "constraints", "unknowns", "success_criteria", "failure_modes"}, "case_brief", errors)
    if brief.get("constraints") != root.get("constraints"):
        errors.append("case_brief constraints must match record constraints")
    run = _obj(root.get("run"), "run", errors)
    _required(run, {"id", "stage", "strict", "worker_cap", "workers", "completed_worker_ids", "reused_worker_ids", "failures", "capability_shortfall", "assurance", "specialist_additions", "redeliberations", "judge_fallback"}, "run", errors)
    stage = run.get("stage")
    if stage not in STAGES:
        errors.append("run.stage must be LOW, MEDIUM, HIGH, or CRITICAL")
    cap = run.get("worker_cap")
    if not isinstance(cap, int) or isinstance(cap, bool) or not 0 <= cap <= 8:
        errors.append("run.worker_cap must be an integer from 0 through 8")
        cap = 8
    assurance = run.get("assurance")
    strict_shortfall = run.get("strict") is True and run.get("capability_shortfall") is True
    if assurance not in {"independent", "partially_independent", "single_agent", "provisional"}:
        errors.append("run.assurance must be independent, partially_independent, single_agent, or provisional")
    if not strict_shortfall:
        if stage == "LOW" and assurance not in ({"single_agent", "provisional"} if run.get("judge_fallback") is not None else {"single_agent"}): errors.append("LOW must use single_agent assurance unless a fallback is recorded")
        if stage == "MEDIUM" and assurance not in {"independent", "partially_independent", "provisional"}: errors.append("MEDIUM assurance is invalid")
        if stage in {"HIGH", "CRITICAL"} and assurance not in {"independent", "partially_independent", "provisional"}: errors.append("HIGH/CRITICAL assurance is invalid")
    if run.get("capability_shortfall") is not bool(missing_set):
        errors.append("run capability_shortfall must match preflight missing capabilities")
    workers = _list(run.get("workers"), "run.workers", errors)
    worker_by_id: dict[str, dict[str, Any]] = {}
    for i, value in enumerate(workers):
        worker = _obj(value, f"run.workers[{i}]", errors)
        _required(worker, {"id", "role", "status"}, f"run.workers[{i}]", errors)
        wid = worker.get("id")
        if not isinstance(wid, str) or not wid:
            errors.append(f"run.workers[{i}].id must be a nonempty string")
        elif wid in worker_by_id:
            errors.append(f"duplicate worker id: {wid}")
        else:
            worker_by_id[wid] = worker
    manifest = _list(root.get("panel_manifest"), "panel_manifest", errors)
    manifest_ids = {item.get("id") for item in (_obj(x, "panel_manifest[]", errors) for x in manifest)}
    if manifest_ids != set(worker_by_id) or manifest != workers: errors.append("panel_manifest must exactly equal run.workers")
    distinct_workers = set(worker_by_id)
    instantiated = {wid for wid,w in worker_by_id.items() if w.get("instantiated") is True}

    def eligible_reviewer(worker: dict[str, Any] | None) -> bool:
        stages = worker.get("participated_stages", []) if worker else []
        return bool(worker and worker.get("classification") == "reviewer"
                    and worker.get("is_judge") is not True and worker.get("instantiated") is True
                    and worker.get("status") == "completed" and worker.get("blind_round1") is True
                    and worker.get("context_isolated") is True and "round1" in stages
                    and "final_judge" not in stages and "adaptive_specialist" not in stages)

    def eligible_judge(worker: dict[str, Any] | None) -> bool:
        stages = worker.get("participated_stages", []) if worker else []
        return bool(worker and worker.get("classification") == "judge" and worker.get("is_judge") is True
                    and worker.get("instantiated") is True and worker.get("status") == "completed"
                    and worker.get("blind_round1") is False and worker.get("context_isolated") is True
                    and stages == ["final_judge"])
    if len(instantiated) > cap:
        errors.append("worker cap exceeded by distinct workers")
    for failure in _list(run.get("failures"), "run.failures", errors):
        item = _obj(failure, "run.failures[]", errors)
        _required(item, {"worker_id", "reason"}, "run.failures[]", errors)
        worker_id = item.get("worker_id")
        if worker_id not in worker_by_id or worker_by_id[worker_id].get("status") != "failed":
            errors.append("each recorded failure must identify a failed manifest worker")
        if not isinstance(item.get("reason"), str) or not item.get("reason").strip():
            errors.append("each worker failure needs a reason")

    failure_ids = [item.get("worker_id") for item in run.get("failures", []) if isinstance(item, dict)]
    if len(failure_ids) != len(set(failure_ids)):
        errors.append("failed worker identities must be unique")
    declared_failed = {wid for wid, worker in worker_by_id.items() if worker.get("status") == "failed"}
    if set(failure_ids) != declared_failed:
        errors.append("run.failures must exactly identify every failed manifest worker")

    completed = set(_list(run.get("completed_worker_ids"), "run.completed_worker_ids", errors))
    reused = set(_list(run.get("reused_worker_ids"), "run.reused_worker_ids", errors))
    if completed & reused:
        errors.append("completed and reused worker identities must be distinct")
    for wid in completed | reused:
        if wid not in distinct_workers:
            errors.append(f"completed/reused worker {wid!r} is not in run.workers")
        elif wid in completed and worker_by_id[wid].get("status") != "completed":
            errors.append(f"completed worker {wid!r} must have completed status")
        elif wid in reused and worker_by_id[wid].get("status") != "reused":
            errors.append(f"reused worker {wid!r} must have reused status")
    for wid, worker in worker_by_id.items():
        if worker.get("status") == "completed" and wid not in completed: errors.append(f"completed worker {wid!r} missing from completed ids")
        if worker.get("status") == "reused" and wid not in reused: errors.append(f"reused worker {wid!r} missing from reused ids")
        if worker.get("status") in {"completed", "reused", "failed"} and worker.get("instantiated") is not True: errors.append(f"lifecycle worker {wid!r} must be instantiated")
    if len(completed) != len(_list(run.get("completed_worker_ids"), "run.completed_worker_ids", errors)):
        errors.append("completed worker ids must be unique")
    if len(reused) != len(_list(run.get("reused_worker_ids"), "run.reused_worker_ids", errors)):
        errors.append("reused worker ids must be unique")

    judge_id = run.get("fresh_judge_id")
    fallback = run.get("judge_fallback")
    if stage in {"HIGH", "CRITICAL"} and not strict_shortfall:
        if fallback is None and (not isinstance(judge_id, str) or judge_id not in distinct_workers):
            errors.append("HIGH/CRITICAL requires a fresh Judge in run.workers")
        elif fallback is None and judge_id not in completed:
            errors.append("fresh Judge must be completed")
        elif fallback is None and not eligible_judge(worker_by_id[judge_id]):
            errors.append("fresh_judge_id must identify a worker marked is_judge")
        reviewer_ids = {wid for wid, worker in worker_by_id.items() if eligible_reviewer(worker)}
        if fallback is None and (judge_id in reviewer_ids or judge_id in reused):
            errors.append("Judge must be fresh, not a reused reviewer")
        if stage == "HIGH" and len(reviewer_ids) < 4 and assurance == "independent" and not run.get("capability_shortfall"):
            errors.append("HIGH requires at least four eligible completed reviewers")
        if stage == "CRITICAL":
            if not 5 <= len(reviewer_ids) <= 6 and assurance == "independent" and not run.get("capability_shortfall"):
                errors.append("CRITICAL requires five or six completed/reused reviewers")
            roles = " ".join(str(worker_by_id[w].get("role", "")).lower() for w in reviewer_ids)
            if "red team" not in roles and "independent design-assurance" not in roles:
                errors.append("CRITICAL requires a red-team or independent design-assurance reviewer")
        if assurance == "partially_independent" and not reviewer_ids:
            errors.append("partially_independent HIGH/CRITICAL requires at least one eligible reviewer")
    elif stage == "LOW" and judge_id is not None:
        errors.append("LOW must not claim a fresh Judge")
    elif stage == "MEDIUM" and judge_id is not None:
        judge = worker_by_id.get(judge_id)
        if not eligible_judge(judge) or judge_id not in completed or judge_id in reused:
            errors.append("MEDIUM fresh Judge must be completed, isolated, final_judge, and unreused")
    if fallback is not None:
        fb = _obj(fallback, "run.judge_fallback", errors)
        if fb.get("provisional") is not True or not isinstance(fb.get("reason"), str) or not fb.get("reason").strip():
            errors.append("Judge fallback must be provisional and explain its reason")
        if judge_id is not None:
            errors.append("Judge fallback and fresh Judge cannot both be recorded")
        if stage in {"HIGH", "CRITICAL"} and assurance != "provisional":
            errors.append("HIGH/CRITICAL Judge fallback must use provisional assurance")
        if run.get("strict") is True:
            errors.append("strict execution cannot use a Judge fallback")
    if strict_shortfall:
        empty_fields = ("workers", "completed_worker_ids", "reused_worker_ids", "failures", "specialist_additions", "redeliberations")
        root_empty = ("panel_manifest", "material_claims", "issue_ledger", "axis_decisions")
        cross_now = root.get("cross_examination") or {}
        if (assurance != "provisional" or root.get("consensus_proposal") is not None or judge_id is not None or fallback is not None or
            instantiated or not preflight.get("missing_capabilities") or any(run.get(key) for key in empty_fields) or
            any(root.get(key) for key in root_empty) or cross_now.get("decision") != "skip" or not cross_now.get("reason") or
            any(cross_now.get(key) for key in ("trigger_items", "selected_item_ids", "coverage", "followups"))):
            errors.append("strict capability shortfall requires provisional assurance, zero instantiated workers, missing capabilities, and null consensus")
        return errors
    if stage == "LOW" and distinct_workers:
        errors.append("LOW must not create panel workers")
    if stage == "MEDIUM":
        reviewer_count = len([w for w in worker_by_id.values() if eligible_reviewer(w)])
        if not 2 <= reviewer_count <= 3:
            errors.append("MEDIUM requires two or three eligible completed reviewers")
        if assurance == "independent" and judge_id is None:
            errors.append("MEDIUM independent assurance requires a fresh Judge")

    specialists = _list(run.get("specialist_additions"), "run.specialist_additions", errors)
    if len(specialists) > 1:
        errors.append("at most one specialist addition is allowed")
    specialist_worker_ids: list[str] = []
    for specialist in specialists:
        item=_obj(specialist, "run.specialist_additions[]", errors)
        worker=worker_by_id.get(item.get("worker_id"))
        if isinstance(item.get("worker_id"), str): specialist_worker_ids.append(item["worker_id"])
        if (not isinstance(item.get("admission_reason"), str) or not item.get("admission_reason").strip() or not isinstance(item.get("reason"), str) or not item.get("reason").strip() or not worker or worker.get("classification") != "adaptive_specialist" or worker.get("status") != "completed" or worker.get("instantiated") is not True or worker.get("is_judge") is True or worker.get("blind_round1") is not False or worker.get("context_isolated") is not True or "adaptive_specialist" not in worker.get("participated_stages", []) or item.get("classification") != "adaptive_specialist" or item.get("admission") != {"material_gap":True,"distinct_capability":True,"verdict_change_possible":True,"cap_available":True}): errors.append("specialist must link an adaptive worker and satisfy all admission conditions")
    declared_specialists = {wid for wid, worker in worker_by_id.items() if worker.get("classification") == "adaptive_specialist" and worker.get("instantiated") is True and worker.get("status") == "completed"}
    if len(specialist_worker_ids) != len(set(specialist_worker_ids)) or set(specialist_worker_ids) != declared_specialists:
        errors.append("specialist additions must exactly identify every completed adaptive specialist worker")
    redeliberations = _list(run.get("redeliberations"), "run.redeliberations", errors)
    if len(redeliberations) > 1:
        errors.append("at most one re-deliberation is allowed")
    for i, item in enumerate(redeliberations):
        redeliberation = _obj(item, f"run.redeliberations[{i}]", errors)
        scope = redeliberation.get("impacted_scope")
        participants = redeliberation.get("participant_worker_ids")
        if (not isinstance(scope, list) or not scope or not all(isinstance(x, str) and x.strip() for x in scope)
                or redeliberation.get("non_independent") is not True or not isinstance(participants, list)
                or not participants or len(participants) != len(set(participants))):
            errors.append("each re-deliberation requires a nonempty impacted_scope")
        else:
            for worker_id in participants:
                worker = worker_by_id.get(worker_id)
                if (not worker or worker.get("instantiated") is not True or worker.get("status") != "completed"
                        or worker.get("classification") not in {"reviewer", "adaptive_specialist"}):
                    errors.append("redeliberation participants must be completed existing reviewers or specialists")

    claims = _list(root.get("material_claims"), "material_claims", errors)
    claim_status: dict[str, set[str]] = {}
    for i, raw_claim in enumerate(claims):
        claim = _obj(raw_claim, f"material_claims[{i}]", errors)
        _required(claim, {"id", "statement", "provenance"}, f"material_claims[{i}]", errors)
        cid = claim.get("id")
        if not isinstance(cid, str) or not cid:
            errors.append(f"material_claims[{i}].id must be nonempty")
            continue
        if cid in claim_status:
            errors.append(f"duplicate material claim id: {cid}")
            continue
        statuses: set[str] = set()
        provenance = _list(claim.get("provenance"), f"material_claims[{i}].provenance", errors)
        if not provenance:
            errors.append(f"material claim {cid} needs provenance")
        for j, raw_prov in enumerate(provenance):
            prov = _obj(raw_prov, f"material_claims[{i}].provenance[{j}]", errors)
            _required(prov, {"locator", "verification_status", "verification_note"}, f"material_claims[{i}].provenance[{j}]", errors)
            status = prov.get("verification_status")
            if status not in STATUSES:
                errors.append(f"claim {cid} has invalid verification status")
            else:
                statuses.add(status)
            if status == "verified":
                if not isinstance(prov.get("locator"), str) or not prov["locator"].strip():
                    errors.append(f"verified provenance for {cid} needs a locator")
                if not isinstance(prov.get("verification_note"), str) or not prov["verification_note"].strip():
                    errors.append(f"verified provenance for {cid} needs a verification note")
        claim_status[cid] = statuses

    # Security boundary: DecisionRecord is an evidence ledger, not a prompt store.
    forbidden = {"chain_of_thought", "raw_reasoning", "internal_prompt", "system_prompt", "execution_directive", "tool_directive"}
    def scan(value: Any, path: str = "$") -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.lower() in forbidden:
                    errors.append(f"{path}.{key} must not retain raw reasoning or prompts")
                scan(child, f"{path}.{key}")
        elif isinstance(value, list):
            for index, child in enumerate(value): scan(child, f"{path}[{index}]")
    scan(root)

    required_constraints = set(_list(root.get("required_constraints"), "required_constraints", errors))
    if not required_constraints.issubset(set(_list(root.get("constraints"), "constraints", errors))):
        errors.append("required_constraints must be declared constraints")
    for issue in _list(root.get("issue_ledger"), "issue_ledger", errors):
        obj = _obj(issue, "issue_ledger[]", errors)
        _required(obj, {"issue_id", "status", "rationale", "required_evidence", "available_evidence"}, "issue_ledger[]", errors)
        if obj.get("status") not in {"CONFIRMED", "REFUTED", "PARTIALLY_SUPPORTED", "UNRESOLVED", "NOT_OBSERVABLE"}: errors.append("issue ledger has invalid status")
    observability = _obj(root.get("observability"), "observability", errors)
    _required(observability, {"wall_time", "tokens", "tool_calls", "worker_count"}, "observability", errors)
    for key, value in observability.items():
        if isinstance(value, str) and value != "NOT_OBSERVABLE": errors.append(f"observability.{key} string values must be NOT_OBSERVABLE")
    worker_count = observability.get("worker_count")
    if isinstance(worker_count, (int, float)) and not isinstance(worker_count, bool) and worker_count != len(instantiated):
        errors.append("observability.worker_count must equal the instantiated worker count")

    cross = _obj(root.get("cross_examination"), "cross_examination", errors)
    _required(cross, {"decision", "reason", "trigger_items", "selected_item_ids", "coverage", "followups"}, "cross_examination", errors)
    decision = cross.get("decision")
    triggers = _list(cross.get("trigger_items"), "cross_examination.trigger_items", errors)
    selected = _list(cross.get("selected_item_ids"), "cross_examination.selected_item_ids", errors)
    coverage = _list(cross.get("coverage"), "cross_examination.coverage", errors)
    followups = _list(cross.get("followups"), "cross_examination.followups", errors)
    if decision not in {"run", "skip"}: errors.append("cross_examination.decision must be run or skip")
    if not isinstance(cross.get("reason"), str) or not cross.get("reason").strip(): errors.append("cross-examination requires a reason")
    trigger_origins: dict[str, Any] = {}
    for i, item in enumerate(triggers):
        obj = _obj(item, f"cross_examination.trigger_items[{i}]", errors)
        tid = obj.get("id")
        if not isinstance(tid, str) or not tid: errors.append("trigger item needs id")
        elif tid in trigger_origins:
            errors.append("cross-examination trigger item ids must be unique")
        else:
            origin = obj.get("origin_reviewer")
            trigger_origins[tid] = origin
            worker = worker_by_id.get(origin)
            if not eligible_reviewer(worker):
                errors.append("cross trigger origin must be an eligible reviewer")
    if decision == "skip" and (triggers or selected or coverage or followups):
        errors.append("cross-examination skip requires empty triggers, selection, coverage, and followups")
    if decision == "run":
        if not triggers or not coverage or not followups:
            errors.append("cross-examination run requires trigger, coverage, and followup evidence")
        if len(selected) != len(set(selected)) or set(trigger_origins) != set(selected):
            errors.append("cross-examination run must select every trigger item exactly once and no other items")
        coverage_entries = [_obj(x, "cross_examination.coverage[]", errors) for x in coverage]
        coverage_item_ids = [entry.get("item_id") for entry in coverage_entries]
        if len(coverage_item_ids) != len(set(coverage_item_ids)) or set(coverage_item_ids) != set(selected):
            errors.append("cross coverage must identify every selected item exactly once")
        coverage_by_item = {entry.get("item_id"): entry.get("reviewer_ids", []) for entry in coverage_entries}
        for item_id in selected:
            ids = coverage_by_item.get(item_id, [])
            origin = trigger_origins.get(item_id)
            if not isinstance(ids, list) or len(ids) != len(set(ids)) or not any(isinstance(r, str) and r != origin for r in ids):
                errors.append(f"selected item {item_id!r} lacks non-origin reviewer coverage")
            for reviewer_id in ids:
                worker = worker_by_id.get(reviewer_id)
                if not eligible_reviewer(worker):
                    errors.append("cross coverage must use an eligible reviewer")
    followup_counts: dict[str, int] = {}
    for entry in followups:
        obj = _obj(entry, "cross_examination.followups[]", errors)
        reviewer_id = obj.get("reviewer_id")
        if isinstance(reviewer_id, str): followup_counts[reviewer_id] = followup_counts.get(reviewer_id, 0) + 1
        reviewer = worker_by_id.get(reviewer_id)
        item_ids = obj.get("item_ids", [])
        if (not eligible_reviewer(reviewer) or len(item_ids) != len(set(item_ids))
                or not set(item_ids).issubset(set(selected))):
            errors.append("cross followup must use eligible reviewer and selected items")
    if any(count > 1 for count in followup_counts.values()): errors.append("a reviewer may receive at most one cross-examination follow-up")
    if decision == "run":
        for item_id, reviewer_ids in coverage_by_item.items():
            if not any(entry.get("reviewer_id") in reviewer_ids and item_id in entry.get("item_ids", []) for entry in followups if isinstance(entry, dict)):
                errors.append("cross coverage must be backed by a matching reviewer followup")

    axes = _list(root.get("axis_decisions"), "axis_decisions", errors)
    axis_names = set()
    for i, raw_axis in enumerate(axes):
        axis = _obj(raw_axis, f"axis_decisions[{i}]", errors)
        name = axis.get("axis")
        if not isinstance(name, str) or not name: errors.append("axis decision needs axis")
        elif name in axis_names: errors.append("duplicate axis decision")
        else: axis_names.add(name)
        for claim_id in _list(axis.get("evidence_claim_ids"), "axis_decision.evidence_claim_ids", errors):
            if claim_id not in claim_status or claim_status[claim_id] != {"verified"}:
                errors.append("axis evidence must reference an existing verified claim")
    valid_scope_ids = set(claim_status) | {str(_obj(item, "issue_ledger[]", errors).get("issue_id")) for item in _list(root.get("issue_ledger"), "issue_ledger", errors)} | axis_names
    for redeliberation in redeliberations:
        scope = _obj(redeliberation, "run.redeliberations[]", errors).get("impacted_scope", [])
        if len(scope) != len(set(scope)) or not set(scope).issubset(valid_scope_ids): errors.append("redeliberation scope must contain unique existing claim, issue, or axis IDs")
    if (declared_specialists or redeliberations) and assurance == "independent": errors.append("material adaptive work requires partially_independent or provisional assurance")
    if assurance == "independent" and (missing_set or run.get("failures") or reused):
        errors.append("independent assurance requires no missing capability, worker failure, or reused worker")

    if root.get("consensus_proposal") is None:
        errors.append("normal execution requires a consensus_proposal object")
        return errors
    proposal = _obj(root.get("consensus_proposal"), "consensus_proposal", errors)
    _required(proposal, {"status", "action", "supported_by_verified_claims", "satisfied_constraints", "axis_alignment", "conditions", "unresolved_dissent", "no_consensus_reason", "remaining_options", "decision_owner"}, "consensus_proposal", errors)
    status = proposal.get("status")
    supported = _list(proposal.get("supported_by_verified_claims"), "consensus_proposal.supported_by_verified_claims", errors)
    if status in {"consensus", "conditional_consensus"} and (not supported or not axes):
        errors.append("consensus and conditional_consensus require verified support and at least one decision axis")
    for cid in supported:
        if cid not in claim_status or claim_status[cid] != {"verified"}:
            errors.append(f"consensus link {cid!r} must reference only verified provenance")
    constraints = set(_list(root.get("constraints"), "constraints", errors))
    satisfied = _list(proposal.get("satisfied_constraints"), "consensus_proposal.satisfied_constraints", errors)
    for constraint in satisfied:
        if constraint not in constraints: errors.append(f"consensus references undeclared constraint {constraint!r}")
    alignment = _list(proposal.get("axis_alignment"), "consensus_proposal.axis_alignment", errors)
    alignment_entries = [_obj(x, "consensus_proposal.axis_alignment[]", errors) for x in alignment]
    aligned_axes = {entry.get("axis") for entry in alignment_entries}
    if status != "no_consensus" and (axis_names != aligned_axes or len(alignment) != len(axis_names)):
        errors.append("consensus must link every decision axis exactly")
    if status != "no_consensus" and any(entry.get("decision_ref") != entry.get("axis") for entry in alignment_entries):
        errors.append("consensus axis decision_ref must identify its axis decision")
    dissent = _list(proposal.get("unresolved_dissent"), "consensus_proposal.unresolved_dissent", errors)
    material_dissent = any(_obj(item, "consensus_proposal.unresolved_dissent[]", errors).get("material") is True for item in dissent)
    if status == "consensus":
        if not isinstance(proposal.get("action"), str) or not proposal["action"].strip(): errors.append("consensus requires an action")
        if proposal.get("conditions"): errors.append("unconditional consensus must not have conditions")
        if material_dissent: errors.append("material unresolved dissent prevents unconditional consensus")
        if any(_obj(issue, "issue_ledger[]", errors).get("status") in {"UNRESOLVED", "NOT_OBSERVABLE"} for issue in root.get("issue_ledger", [])):
            errors.append("unresolved material issues prevent unconditional consensus")
        if set(satisfied) != required_constraints: errors.append("consensus must link every required constraint")
    elif status == "conditional_consensus":
        if not isinstance(proposal.get("action"), str) or not proposal["action"].strip(): errors.append("conditional consensus requires an action")
        if not proposal.get("conditions"): errors.append("conditional consensus requires conditions")
        if set(satisfied) != required_constraints: errors.append("conditional consensus must link every required constraint")
    elif status == "no_consensus":
        if proposal.get("action") is not None: errors.append("no_consensus action must be null")
        if not isinstance(proposal.get("no_consensus_reason"), str) or not proposal["no_consensus_reason"].strip(): errors.append("no_consensus requires a reason")
        if not _list(proposal.get("remaining_options"), "consensus_proposal.remaining_options", errors): errors.append("no_consensus requires remaining options")
        if not isinstance(proposal.get("decision_owner"), str) or not proposal["decision_owner"].strip(): errors.append("no_consensus requires a decision owner")
    else:
        errors.append("consensus status is invalid")
    if status != "no_consensus" and (proposal.get("no_consensus_reason") is not None or proposal.get("decision_owner") is not None):
        errors.append("only no_consensus may include no-consensus reason or owner")
    return errors


def validate_issues(record: Any) -> list[tuple[str, str]]:
    """Stable, non-sensitive diagnostic codes paired with CLI-only messages."""
    rules = [
        ("unknown schema property", "schema.unknown_property"), ("violates schema anyof", "schema.any_of"),
        ("violates schema type", "schema.type"), ("violates schema const", "schema.const"),
        ("violates schema enum", "schema.enum"), ("missing schema-required", "schema.required"),
        ("violates schema minitems", "schema.min_items"), ("violates schema maxitems", "schema.max_items"),
        ("violates schema minlength", "schema.min_length"), ("violates schema pattern", "schema.pattern"),
        ("violates schema minimum", "schema.minimum"), ("violates schema maximum", "schema.maximum"),
        ("LOW must not", "run.low_workers"), ("worker cap", "run.worker_cap"),
        ("HIGH requires", "run.high_contract"),
        ("MEDIUM", "run.medium_contract"), ("CRITICAL requires", "run.critical_contract"),
        ("partially_independent", "run.partial_contract"), ("eligible reviewer", "worker.reviewer_eligibility"),
        ("fresh Judge", "run.fresh_judge"), ("fresh_judge_id", "run.fresh_judge"), ("fallback", "run.fallback"),
        ("cross-examination requires", "cross.reason"), ("cross-examination skip", "cross.skip_nonempty"), ("cross-examination run", "cross.trigger_coverage"),
        ("cross trigger", "cross.trigger_origin"), ("cross coverage", "cross.coverage"),
        ("cross followup", "cross.followup"), ("non-origin", "cross.nonorigin_coverage"), ("follow-up", "cross.followup_cap"),
        ("invalid verification status", "evidence.invalid_status"), ("verified provenance", "evidence.verified_provenance"), ("consensus link", "consensus.verified_links"),
        ("consensus and conditional_consensus", "consensus.minimum_evidence"),
        ("unresolved material issues", "consensus.unresolved_issue"),
        ("material unresolved dissent", "consensus.material_dissent"), ("undeclared constraint", "consensus.declared_constraints"), ("required constraint", "consensus.required_constraints"), ("decision axis", "axis.coverage"),
        ("issue ledger", "issue.invalid"), ("observability", "observability.invalid"), ("strict capability", "run.strict_shortfall"),
        ("redeliberation", "adaptive.redeliberation"), ("re-deliberation", "adaptive.redeliberation"), ("specialist", "adaptive.specialist"),
        ("completed and reused", "lifecycle.completed_reused"), ("raw reasoning", "security.raw_reasoning"),
        ("failed worker", "lifecycle.failed"), ("lifecycle worker", "lifecycle.instantiated"),
        ("preflight", "preflight.consistency"), ("capability_shortfall", "preflight.shortfall"),
        ("case_brief constraints", "case.constraints"), ("schema_version", "version.schema"),
        ("skill_version", "version.skill"), ("assurance", "run.assurance"),
        ("panel_manifest", "manifest.coverage"), ("duplicate worker", "worker.duplicate"),
        ("completed worker", "worker.completed_status"), ("reused worker", "worker.reused_status"),
        ("no_consensus", "consensus.no_consensus_shape"), ("only no_consensus", "consensus.no_consensus_fields"),
        ("axis", "axis.coverage"), ("provisional", "run.provisional"),
        ("axis evidence", "axis.verified_evidence"), ("duplicate axis", "axis.duplicate"),
    ]
    issues=[]
    for message in validate(record):
        lower=message.lower(); code=next((code for needle,code in rules if needle.lower() in lower), "contract.rule_violation")
        issues.append((code,message))
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an Independent Deliberation Panel DecisionRecord v1")
    parser.add_argument("record", type=Path)
    parser.add_argument("--json", action="store_true", help="emit machine-readable errors")
    args = parser.parse_args()
    try:
        data = json.loads(args.record.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors = [f"cannot load {args.record}: {exc}"]
    else:
        errors = validate(data)
    if args.json:
        issues = validate_issues(data) if 'data' in locals() else [("input.load", error) for error in errors]
        print(json.dumps({"valid": not errors, "issues": [{"code": code, "message": message} for code, message in issues]}, ensure_ascii=False))
    elif errors:
        print(f"INVALID {args.record}", file=sys.stderr)
        for error in errors: print(f"- {error}", file=sys.stderr)
    else: print(f"VALID {args.record}")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
