#!/usr/bin/env python3
"""Launch the approved child exactly once, detached (own session), then observe for 60 s and record state.
Never kills or relaunches. Only CLAUDE_CONFIG_DIR is set (messaging socket/token vars are unset as in prior runs)."""
import datetime, json, os, subprocess, sys

K = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-child-1"
C = "<REDACTED_HOME>/cs281-b28a-20261006T110419Z/c2-git-v2"
RUN = K + "/run"
META = RUN + "/launch-meta.json"
if os.path.exists(META):
    sys.exit("launch-meta exists: refusing second launch")
now = lambda: datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
prompt = open(RUN + "/prompt-argv.bin", "rb").read().decode()
argv = ["claude", "-p", "--model", "claude-sonnet-5-5", "--effort", "high", "--max-turns", "8",
        "--max-budget-usd", "1.00", "--input-format", "text", "--output-format", "stream-json", "--verbose",
        "--tools", "Skill", "--allowedTools", "Skill", "--disallowedTools", "mcp__*", "--", prompt]
env = dict(os.environ)
env.pop("CLAUDE_CODE_MESSAGING_SOCKET", None); env.pop("CLAUDE_CODE_MESSAGING_TOKEN", None)
env["CLAUDE_CONFIG_DIR"] = C + "/claude-config"
cwd = C + "/child-cwd"
out = open(RUN + "/child.stdout", "wb"); err = open(RUN + "/child.stderr", "wb")
start = now()
p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
meta = {"launchCount": 1, "startUtc": start, "pid": p.pid, "pgid": os.getpgid(p.pid), "cwd": cwd,
        "env_set": {"CLAUDE_CONFIG_DIR": env["CLAUDE_CONFIG_DIR"]}, "env_unset": ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"],
        "argv_without_prompt": argv[:-1], "promptSha256": "3eaca6bd5b906c7fc2eb2ff1322b2795fa9ac9b5f0b5e23e9673d8773b301af1"}
json.dump(meta, open(META, "w"), indent=2)
try:
    rc = p.wait(timeout=60); state = "EXITED"
except subprocess.TimeoutExpired:
    rc = None; state = "RUNNING_UNKNOWN"
obs = {"observedUtc": now(), "stateAt60s": state, "exitCode": rc}
json.dump(obs, open(RUN + "/observe-60s.json", "w"), indent=2)
print(json.dumps({**meta, **obs}, indent=1)[:1500])
