"""Check current pre-dispatch package contracts; keep legacy fixture checks separate.

This is a source/contract validator, not a substitute for predispatch.test.mjs's
resolver/CLI/application behavior checks or caller-visible host observation.
"""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILL_ROOT = ROOT / "skills" / "model-effort-advisor"
CASES = Path(__file__).with_name("behavior-cases.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_current_contract() -> None:
    text = (SKILL_ROOT / "SKILL.md").read_text(encoding="utf-8") + "\n" + (SKILL_ROOT / "references" / "entry-details.md").read_text(encoding="utf-8")
    for clause in [
        "현재 메인 모델이나 추론 수준 관측은 입력도 선행조건도 아니다.",
        "위임 여부·에이전트 수·배치·문맥·권한·독립 감사",
        "쉬운 검증·작업 분해·비용 선호로 고위험 추천을 낮추지 마라.",
        "`user.model`, `user.effort`는 지원 범위에서 우선하며 하나만 제공해도",
        "`host.id`는 실행 호스트 식별자이고 `host.provider`는 모델 catalog/라우팅 adapter 식별자다.",
        "구체적인 제품 모델명·별칭·벤더 API·호출 필드 변환은",
        "호출 자체는 coordinate 담당이다.",
        "`requested`는 요청한 값, `dispatched`는 실제 보낸 인자, `observation`/`actual`은 호스트에서 확인한 결과다.",
        "dispatch 허가·assignment 완료·검증 통과를 뜻하지 않는다.",
        "관측이 없으면 `unverified`",
        "SubagentModelRequest.v1", "SubagentModelAdvice.v1",
    ]:
        require(clause in text, f"missing pre-dispatch instruction: {clause}")

    request = read_json(SKILL_ROOT / "contracts" / "subagent-model-request.v1.schema.json")
    advice = read_json(SKILL_ROOT / "contracts" / "subagent-model-advice.v1.schema.json")
    policy = read_json(ROOT / "contracts" / "model-policy.v1.schema.json")
    presets = read_json(ROOT / "runtime" / "model-routing-presets.json")
    classification = read_json(SKILL_ROOT / "classification.json")
    require(classification["actions"] == ["select-subagent-model-effort"], "current action must select before dispatch")
    require(classification["targets"] == ["approved-subagent-assignment", "host-model-capabilities"], "current targets must not be main settings")
    require(request["additionalProperties"] is False, "request must reject undeclared observation/authority fields")
    require(set(request["required"]) == {"schemaVersion", "assignment", "host"}, "parent-model observation must not be required")
    require(set(request["properties"]) == {"schemaVersion", "assignment", "host", "preference", "user"}, "current-main UI fields are not request inputs")
    assignment = request["$defs"]["assignment"]
    require(set(assignment["required"]) == {"role", "difficulty", "riskLevel", "verification", "signals"}, "assignment criteria must be explicit")
    require(assignment["properties"]["role"]["enum"] == presets["roles"], "roles must reuse the routing policy")
    require(assignment["properties"]["difficulty"]["enum"] == ["routine", "substantial", "complex", "frontier"], "difficulty criteria must remain explicit")
    require(assignment["properties"]["riskLevel"]["enum"] == ["low", "medium", "high", "critical"], "risk criteria must preserve high and critical assignments")
    require(assignment["properties"]["signals"]["minItems"] >= 1, "assignment decisions need actual rationale")
    require(assignment["properties"]["verification"]["enum"] == ["direct", "indirect", "limited"], "verification limits must remain explicit")
    require(request["properties"]["preference"]["enum"] == ["economy", "balanced", "quality"], "supported preference contract changed")

    host = request["properties"]["host"]
    require(set(host["required"]) == {"id", "provider", "capabilityReference", "supported"}, "host support requires separate identity, provider and source")
    require(host["properties"]["id"] == host["properties"]["provider"] == {"$ref": "#/$defs/text"}, "host/vendor IDs must be opaque and extensible")
    supported = host["properties"]["supported"]["items"]
    require(set(supported["required"]) == {"model", "modelClass", "efforts"}, "capabilities must declare exact combinations")
    require(supported["properties"]["model"] == {"$ref": "#/$defs/text"}, "core must not own a vendor model catalog")
    effort_ref = {"$ref": policy["$id"] + "#/$defs/reasoningEffort"}
    class_ref = {"$ref": policy["$id"] + "#/$defs/modelClass"}
    require(supported["properties"]["efforts"]["items"] == effort_ref, "efforts must use the shared policy")
    require(supported["properties"]["modelClass"]["anyOf"] == [class_ref, {"type": "null"}], "unknown model class must remain unknown")
    user = request["properties"]["user"]
    require(set(user["properties"]) == {"model", "effort"} and not user.get("required") and user["minProperties"] == 1, "model-only and effort-only overrides must remain valid")
    require(user["properties"]["effort"] == effort_ref, "user effort must not invent support")
    require(request["$defs"]["setting"]["properties"]["effort"] == effort_ref, "inherited effort must use the same policy")
    require(policy["$defs"]["highRiskModelClass"]["const"] == "general" and policy["$defs"]["highRiskReasoningEffort"]["const"] == "high", "shared high-risk recommendation must stay general/high")

    properties = advice["properties"]
    statuses = {"READY", "INHERIT_UNVERIFIED", "BLOCKED"}
    require(advice["additionalProperties"] is False and set(properties["status"]["enum"]) == statuses, "advice must use the current closed status contract")
    require(properties["authorityEffect"] == {"const": "none"} and "authorityEffect" in advice["required"], "advice must explicitly deny any authorization effect")
    require(not {"actual", "observation", "dispatched"}.intersection(properties), "pre-dispatch advice must not claim effective application")
    require(properties["routingOptions"]["properties"]["user"] == {"$ref": request["$id"] + "#/properties/user"}, "routing must preserve exact user overrides")
    plan = properties["selectionPlan"]
    require(set(plan["required"]) == {"requested", "selection", "delivery", "fallbackReason"}, "requested and supported selection must remain distinct")
    require(plan["properties"]["delivery"]["enum"] == ["explicit", "inherited", "blocked"], "delivery must preserve resolver fallback semantics")
    constraints = {rule["if"]["properties"]["status"]["const"]: rule["then"]["properties"]["selectionPlan"]["properties"] for rule in advice["allOf"]}
    require(set(constraints) == statuses, "each advice status must bind its selection and delivery")
    require(constraints["READY"] == {"selection": {"type": "object"}, "delivery": {"enum": ["explicit", "inherited"]}}, "READY needs a supported selection, not an execution claim")
    for status, delivery in [("INHERIT_UNVERIFIED", "inherited"), ("BLOCKED", "blocked")]:
        require(constraints[status] == {"selection": {"type": "null"}, "delivery": {"const": delivery}}, f"{status} must not invent a selection")

    entries = [entry for entry in read_json(ROOT / "skills" / "registry.json")["skills"] if entry["skillId"] == "model-effort-advisor"]
    require(len(entries) == 1 and len(entries[0]["providers"]) == 1, "one current advisor provider is required")
    provider = entries[0]["providers"][0]
    require(provider["capabilities"] == ["subagent-model-selection"] and provider["executionClass"] == "bootstrap", "provider must select before dispatch")
    require(set(provider["requiredInputArtifacts"]) == {"subagent-assignment", "host-model-capabilities"}, "provider must require assignment and host support only")
    require("current-model-selection" not in {binding["targetArtifact"] for binding in provider["inputBindings"]}, "provider must not collect current-main settings")
    require(provider["outputSchema"] == "skills/model-effort-advisor/contracts/subagent-model-advice.v1.schema.json", "current provider must not emit legacy fit advice")
    require(provider["producedArtifacts"] == ["subagent-model-advice"], "provider must produce current pre-dispatch advice")
    require(provider["gate"] == {"kind": "none", "policy": "none", "validator": None}, "model advice must not create an authorization gate")
    require(provider["stateMapping"]["selector"] == "/output/status" and set(provider["stateMapping"]["values"]) == statuses, "provider mapping must use advice statuses only")
    for status in statuses:
        require(provider["stateMapping"]["values"][status] == {"state": "passed", "errorRequired": False}, "advice completion is distinct from dispatch permission")


def validate_historical_fixtures() -> None:
    # Frozen v1 fit cases remain historical inputs; no current SKILL prose is inspected here.
    document = json.loads(CASES.read_text(encoding="utf-8"))
    cases = {case["id"]: case["output"] for case in document["cases"]}
    invalid_cases = {case["id"]: case["output"] for case in document["invalidCases"]}
    require(cases["routine-sol-high-is-materially-over"]["verdict"] == "OVER_PROVISIONED", "routine mismatch case must warn")
    require(cases["complex-sol-high-is-adequate"]["userNotice"] is None, "adequate case must stay quiet")
    require(cases["unobservable-does-not-invent-current-selection"]["observation"]["model"] is None, "unobservable case must not invent a model")
    require(cases["unobservable-does-not-invent-current-selection"]["userNotice"] is None, "unobservable ordinary case must stay quiet")
    require(cases["critical-deep-high-is-exact-floor"]["recommendation"]["modelClassMin"] == "deep", "critical floor must allow deep")
    require(cases["critical-deep-high-is-exact-floor"]["recommendation"]["reasoningEffortMin"] == "high", "critical floor must allow high effort")
    require(invalid_cases["mismatch-without-observed-selection"]["observation"]["status"] == "unobservable", "failure case must exercise an unobserved mismatch claim")
    for required_invalid_case in [
        "high-risk-below-model-floor",
        "high-risk-below-effort-floor",
        "critical-risk-below-model-floor",
        "inverted-model-range",
        "inverted-reasoning-range",
    ]:
        require(required_invalid_case in invalid_cases, f"missing invalid behavior case: {required_invalid_case}")


if __name__ == "__main__":
    validate_current_contract()
    validate_historical_fixtures()
    print("model-effort-advisor: current pre-dispatch contracts valid; historical v1 fixtures valid separately")
