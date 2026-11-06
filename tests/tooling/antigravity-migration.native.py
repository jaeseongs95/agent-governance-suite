"""Opt-in Linux TEST: official AGY old-key -> ags installation migration.

Reuses D13 agy-run.py's native print, isolated child group and official
install/uninstall pattern. This test is not packaged as an installer.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import time

AGY = "/home/mcpops/.local/bin/agy"
NAME = "agent-governance-suite"
OLD = "6c247e606646d7853d0403fd952a7cd327721991"
NEW = "d826183e47891dc977416ef8182b3656d86e3fb0"
ARCHIVES = {
    "legacy": ("legacy-6c247e60.tar", "3c3daa28fbcb6754eac89df50bc349639dd03bd8ffc9f59f232ee86036e865bb"),
    "current": ("current-d826183e.tar", "70461ab3994761b82e4d16da4134ea34fae96cadd036c6716c0d64dd17d1b916"),
}
# Unchanged synthetic D13 prompt; no expected answer or proof is supplied.
PROMPT = (
    "이번 작업은 공식 네이티브 AGS MCP 단일 호출 시험입니다. 실제 노출된 get_skill_inventory 도구를 빈 입력 객체로 "
    "정확히 한 번 호출하고 실제 결과의 스킬 수와 discovery 상태만 짧게 보고하세요. 도구가 없거나 거부/오류이면 그 원문을 "
    "보고 종료하세요. 임의 서버 prefix 추측, 직접 프로그램으로 MCP 우회, 설정/설치 변경, 다른 MCP 호출, 같은 호출 재시도, "
    "다른 세션이나 인증파일 열람은 하지 마세요. 검증자가 실제 도구 원문을 별도로 확인합니다."
)


def main(root):
    root = root.resolve(strict=True)
    if not str(root).startswith("/home/mcpops/ags-tests/"):
        raise ValueError("Only the assigned Linux TEST root is supported")
    run = root / "execution"
    run.mkdir(exist_ok=False)
    target = Path.home() / ".gemini/config/plugins" / NAME
    cache_root = Path.home() / ".gemini/antigravity/mcp"
    cache_names = [NAME + "_" + NAME, NAME + "_ags", NAME, "ags"]
    result = {"oldSha": OLD, "newSha": NEW, "modelInvocations": 0, "cases": {}, "stateIsolation": "PUBLIC_ENV_SEPARATE_OLD_NEW"}
    owned_install = False
    expected_manifests = set()

    def write(name, data):
        (run / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def sha(file):
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def cli(label, args, check=True):
        p = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, timeout=40)
        write(label + ".json", {"argv": args, "exit": p.returncode, "stdout": p.stdout.decode(errors="replace"), "stderr": p.stderr.decode(errors="replace")})
        if check and p.returncode:
            raise RuntimeError(label + " exit " + str(p.returncode))
        return p

    def plugins(label):
        p = cli(label, [AGY, "plugin", "list", "--json"])
        return json.loads(p.stdout)

    def cache(label):
        rows = []
        for name in cache_names:
            p = cache_root / name
            if p.is_symlink():
                raise RuntimeError("Cache symlink: preserve and stop")
            # Only exact roots proved absent before this test are observed.
            rows.append({"name": name, "exists": p.exists(), "schemas": [
                {"file": str(f.relative_to(p)), "sha256": sha(f)}
                for f in sorted(p.rglob("*.json")) if f.is_file() and not f.is_symlink()
            ] if p.exists() else []})
        write(label + ".cache.json", rows)
        return rows

    def native(label, state_label):
        workspace = run / (label + "-workspace")
        workspace.mkdir()
        state = run / (state_label + "-state")
        state.mkdir(exist_ok=True)
        env = dict(os.environ)
        for key, value in {
            "DB_PATH": "workflows.sqlite3", "CONTINUITY_DB_PATH": "continuity.sqlite3",
            "SESSION_BOARD_DB_PATH": "session-board.sqlite3", "SESSION_MESSAGE_STATE_DIR": "messages",
            "SHARED_STATE_DIR": "shared", "TRUST_DB_PATH": "trust.sqlite3",
        }.items():
            env["AGENT_GOVERNANCE_" + key] = str(state / value)
        env["AGENT_GOVERNANCE_LOG_CONFIG"] = '{"level":"OFF"}'
        args = [AGY, "-p", PROMPT, "--dangerously-skip-permissions", "--print-timeout", "120s", "--output-format", "stream-json"]
        write(label + ".command.json", {"argv": args, "cwd": str(workspace), "outerTimeoutSec": 150, "stateRoot": str(state)})
        child = subprocess.Popen(args, cwd=workspace, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        result["modelInvocations"] += 1
        started = time.monotonic()
        timed_out = False
        try:
            stdout, stderr = child.communicate(timeout=150)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(child.pid, signal.SIGTERM)
            try:
                stdout, stderr = child.communicate(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                stdout, stderr = child.communicate(timeout=2)
        finally:
            # Exact group started by this test; no process-name/global kill.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(child.pid, sig)
                except ProcessLookupError:
                    break
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    try:
                        os.killpg(child.pid, 0)
                    except ProcessLookupError:
                        break
                    time.sleep(.05)
        try:
            os.killpg(child.pid, 0)
            group_remaining = True
        except ProcessLookupError:
            group_remaining = False
        events = []
        parse_errors = 0
        for line in stdout.splitlines():
            try:
                e = json.loads(line)
            except (ValueError, TypeError):
                parse_errors += 1
                continue
            if e.get("event") == "init":
                events.append({"event": "init", "conversation_id": e.get("init", {}).get("conversation_id")})
            if e.get("event") == "step_update":
                step = e.get("step_update", {})
                if step.get("step_type") == "tool":
                    info = step.get("tool_info", {})
                    params = info.get("parameters", {})
                    # Preserve only this test's public inventory call. Other tool
                    # names/states are recorded without their input/output bodies.
                    selected = {"tool_name": step.get("tool_name"), "state": step.get("state"), "id": step.get("id")}
                    if params.get("ToolName") == "get_skill_inventory":
                        selected["ServerName"] = params.get("ServerName")
                        selected["ToolName"] = params.get("ToolName")
                        selected["output"] = info.get("output")
                        selected["error"] = info.get("error")
                    events.append(selected)
        terminal = [e for e in events if e.get("ToolName") == "get_skill_inventory" and e.get("state") in ("DONE", "ERROR")]
        data = {"pid": child.pid, "exit": child.returncode, "timedOut": timed_out, "seconds": round(time.monotonic() - started, 3),
                "groupRemaining": group_remaining, "escapedDescendants": "NOT_OBSERVED", "stdoutSha256": hashlib.sha256(stdout).hexdigest(),
                "stderrSha256": hashlib.sha256(stderr).hexdigest(), "parseErrors": parse_errors, "events": events,
                "oneInventoryDone": len(terminal) == 1 and terminal[0].get("state") == "DONE"}
        write(label + ".native.json", data)
        cache(label)
        if group_remaining or timed_out:
            raise RuntimeError(label + " native timeout/cleanup incomplete; no next model")
        return data

    with open("/home/mcpops/ags-tests/.heavy.lock", "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            before = plugins("before")
            result["baseline"] = before
            if before or target.exists() or target.is_symlink():
                raise RuntimeError("Installation baseline not empty; preserve and stop")
            if any((cache_root / n).exists() or (cache_root / n).is_symlink() for n in cache_names):
                raise RuntimeError("Cache baseline changed; preserve existing cache and stop")
            cache("before")
            result["version"] = cli("version", [AGY, "--version"]).stdout.decode().strip()
            packages = {}
            for label, (filename, expected_hash) in ARCHIVES.items():
                archive = root / filename
                if sha(archive) != expected_hash:
                    raise RuntimeError("Source archive hash mismatch: " + label)
                p = root / label / NAME
                p.mkdir(parents=True, exist_ok=False)
                with tarfile.open(archive) as tar:
                    tar.extractall(p, filter="data")
                packages[label] = p
                expected_manifests.add(sha(p / "plugin.json"))
                cli(label + "-validate", [AGY, "plugin", "validate", str(p)])
            for label, state_label in [("legacy", "legacy"), ("current", "current")]:
                owned_install = True
                cli(label + "-install", [AGY, "plugin", "install", str(packages[label])])
                result["cases"][label] = {"registration": plugins(label + "-registered"), "mcpKeys": list(json.loads((target / "mcp_config.json").read_text())["mcpServers"])}
                result["cases"][label]["native"] = native(label, state_label)
            invalid = root / "invalid" / NAME
            invalid.mkdir(parents=True)
            (invalid / "plugin.json").write_text('{"name":"agent-governance-suite","version":false}', encoding="utf-8")
            expected_manifests.add(sha(invalid / "plugin.json"))
            previous_hash = sha(target / "plugin.json")
            bad = cli("invalid-install", [AGY, "plugin", "install", str(invalid)], check=False)
            result["cases"]["invalid"] = {"exit": bad.returncode, "manifestPreserved": target.exists() and sha(target / "plugin.json") == previous_hash}
            if target.exists():
                if target.is_symlink() or sha(target / "plugin.json") not in expected_manifests:
                    raise RuntimeError("Unknown recovery target: preserve and stop")
                cli("recovery-uninstall", [AGY, "plugin", "uninstall", NAME])
            cache("recovery-after-uninstall")
            cli("recovery-install", [AGY, "plugin", "install", str(packages["current"])])
            result["cases"]["recovery"] = {"registration": plugins("recovery-registered"), "native": native("recovery", "current")}
        except BaseException as error:
            result["failure"] = str(error)
        finally:
            if owned_install and target.exists():
                if target.is_symlink() or sha(target / "plugin.json") not in expected_manifests:
                    result["cleanupFailure"] = "Unknown installation: preserve; official uninstall not attempted"
                else:
                    result["uninstallExit"] = cli("uninstall", [AGY, "plugin", "uninstall", NAME], check=False).returncode
            result["finalPlugins"] = plugins("after")
            result["pluginRestored"] = result["finalPlugins"] == result.get("baseline") and not target.exists()
            if owned_install:
                result["finalCache"] = cache("after")
            write("result.json", result)
    print(json.dumps({"result": str(run / "result.json"), "failure": result.get("failure"), "models": result["modelInvocations"], "pluginRestored": result.get("pluginRestored")}, ensure_ascii=False))
    transport_failure = any(not c.get("native", {}).get("oneInventoryDone", False) for k, c in result["cases"].items() if k != "invalid")
    return 1 if result.get("failure") or not result.get("pluginRestored") or transport_failure else 0


if __name__ == "__main__":
    raise SystemExit(main(Path(sys.argv[1])))
