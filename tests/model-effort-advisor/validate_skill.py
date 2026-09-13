import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SKILL = ROOT / "skills" / "model-effort-advisor" / "SKILL.md"
CASES = Path(__file__).with_name("behavior-cases.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


text = SKILL.read_text(encoding="utf-8")
for required in [
    "현재 선택을 관측할 수 없는 일반 작업에서는",
    "runtime",
    "user",
    "screenshot",
    "UNDER_PROVISIONED",
    "OVER_PROVISIONED",
    "ADEQUATE",
    "UNOBSERVABLE",
    "설정은 자동으로 바꾸지",
    "구독 한도, 실제 과금이나 사용량은 직접 관측한 근거 없이 추정하지 않는다",
]:
    require(required in text, f"missing required instruction: {required}")

document = json.loads(CASES.read_text(encoding="utf-8"))
cases = {case["id"]: case["output"] for case in document["cases"]}
invalid_cases = {case["id"]: case["output"] for case in document["invalidCases"]}
require(cases["routine-sol-high-is-materially-over"]["verdict"] == "OVER_PROVISIONED", "routine mismatch case must warn")
require(cases["complex-sol-high-is-adequate"]["userNotice"] is None, "adequate case must stay quiet")
require(cases["unobservable-does-not-invent-current-selection"]["observation"]["model"] is None, "unobservable case must not invent a model")
require(cases["unobservable-does-not-invent-current-selection"]["userNotice"] is None, "unobservable ordinary case must stay quiet")
require(invalid_cases["mismatch-without-observed-selection"]["observation"]["status"] == "unobservable", "failure case must exercise an unobserved mismatch claim")

print("model-effort-advisor: valid")
