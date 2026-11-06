# Agent Governance Suite

[한국어](https://github.com/jaeseongs95/agent-governance-suite/blob/main/README.md) | English

Agent Governance Suite (AGS) is a local plugin for Claude Code, Codex, and Antigravity (`agy`). It helps the agent pick the specialist skills a task needs, run multi-step changes as a workflow, and record your corrections and the work still left to do. Sessions on the same computer collaborate through a shared board and PEER messages.

[Installation](#installation) · [What changes after installation](#what-changes-after-installation) · [Usage](#usage) · [Skills](#skills) · [What AGS does not guarantee](#what-ags-does-not-guarantee) · [Troubleshooting](#troubleshooting) · [Documentation](#documentation)

## Components

| Component | What it does |
| --- | --- |
| 24 specialist skills | Each owns one kind of judgment: task contracts, risk preflight, acceptance evidence, independent audit, failure diagnosis, code review, security audit, and more. |
| `orchestrator` | Picks the specialist skills a task needs and connects their order, inputs, and outputs. |
| Local MCP server | Checks workflow plans, stage results, and completion conditions, and provides the work-record, board, and messaging tools. The host starts it on demand; no port or always-on daemon is needed. |
| Host hooks | Add guidance, record observations, and deliver messages at session start, on each user message, around tool calls, and at turn end. |

All state is kept in SQLite files on this computer.

## Installation

You need Node.js **24.0.0 or later** and plugin support in your host. Install AGS in every host that should take part. You do not need to clone this repository or run `pnpm install` to use the plugin.

<!-- release-version:start -->
The current public release is `v3.6.0`, and the examples below install it. 3.x is not compatible with 2.x. Changes for each version are in [GitHub Releases](https://github.com/jaeseongs95/agent-governance-suite/releases) and `docs/release-notes-v<version>.md` (Korean).
<!-- release-version:end -->

### Choose a package

Each host has a Korean package and an English-only package. The English-only package shows AGS messages, MCP tool descriptions, hook text, and errors in English; skill text stays in its source language (mostly Korean). Both use the same state, so you can switch languages by reinstalling. **Enable only one of the two in a host.** With both enabled, Claude Code loads the hooks of only one, and Codex runs both.

| Host | Korean package | English-only package |
| --- | --- | --- |
| Claude Code | `agent-governance-suite@agent-governance-claude` | `agent-governance-suite-en@agent-governance-claude` |
| Codex | `agent-governance-suite@agent-governance` | `agent-governance-suite-en@agent-governance` |
| Antigravity | `agent-governance-suite-antigravity-<tag>.zip` | `agent-governance-suite-antigravity-<tag>-en.zip` |

The commands below install the Korean package. For the English-only package, substitute the name or file from the table. In Claude Code both packages keep the skill names `agent-governance-suite:<skill>`; the Codex English package is named `agent-governance-suite-en` because Codex requires the entry name and the manifest name to match.

### Claude Code

Run inside Claude Code, then start a new session.

```text
/plugin marketplace add jaeseongs95/agent-governance-suite
/plugin install agent-governance-suite@agent-governance-claude
```

### Codex

Run in a terminal:

<!-- release-install:start -->
```bash
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v3.6.0
codex plugin add agent-governance-suite@agent-governance
```
<!-- release-install:end -->

Start a new Codex session, then review and trust the AGS hooks in `/hooks`. Until you do, Codex does not run plugin hooks, so the turn check, work records, the board, and message delivery do not work. Review them again after an update that changes the hook definitions.

### Antigravity (`agy`)

`agy plugin install` accepts only a local directory. Download the install package attached to the release, extract it, and install that directory. The package holds only the files agy reads; installing the whole repository can freeze the Antigravity app's installed-plugins view. Close the Antigravity app while installing; if it is running, the install cannot remove the old plugin folder and fails. On Windows, extract with `Expand-Archive`.

<!-- release-agy:start -->
```bash
curl -LO https://github.com/jaeseongs95/agent-governance-suite/releases/download/v3.6.0/agent-governance-suite-antigravity-v3.6.0.zip
unzip agent-governance-suite-antigravity-v3.6.0.zip
agy plugin install ./agent-governance-suite
agy plugin list
```
<!-- release-agy:end -->

The package already contains the MCP server registration (`mcp_config.json`, server name `ags`, `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`) and the hooks (`hooks.json`), so there is nothing else to configure. `GEMINI.md` and `AGENTS.md` in this repository are guidelines for developing AGS itself and are not part of the package.

## What changes after installation

AGS does not make decisions for the agent. It adds guidance at fixed points, checks progress through the workflow tools, and refuses a few actions.

| When | What changes |
| --- | --- |
| Session start | The common intake rules for choosing skills and using workflows reach the model. After a resume or compaction, AGS only lists saved work-record candidates; the body is loaded only when the agent calls `load_context`. If a workflow is in progress, a summary card for it is also shown after compaction. |
| Every user message | An `[AGS turn check]` notice is added, with the targets of each installed skill. If the message is a correction, a new decision, approval or prohibition, extra work, or a scope change, the notice tells the agent to reconsider its skills and save your words and the remaining work with `checkpoint_context`. It adds about 1,700 characters per message. Claude Code and Codex add it on UserPromptSubmit; agy adds it on the first model call of each turn. |
| Editing product files | Without a workflow, the edit that touches a third distinct product file in one turn is refused, and the refusal includes a minimal `start_workflow` call. While a workflow runs, files outside its `writeTargets` are refused the same way. |
| Changing a workflow | When a workflow-changing tool such as `start_workflow`, `record_stage_result`, or `finalize_workflow` succeeds, the response names the next stage and lists the targets of every installed skill. The provider named for a stage is only the contract its result is recorded under; it does not limit which skills the stage may use. |
| Turn end | If product files were edited and the running workflow still has stages that have not passed, AGS restates the goal and the remaining stages and tells the agent to continue. Pending PEER messages may also be delivered at this point. |
| Session collaboration | Hooks record each session's ID, working directory, and last input time on the board. The agent writes one line about its current work, and other sessions use that line to send PEER messages. The board never blocks work. |

A workflow is marked complete only when every planned stage has passed and nothing is left unresolved. If an unfinished old workflow root still holds a path and a new workflow fails with `ROOT_CONFLICT`, the error `details` show that root's timestamps, latest run, owning session state, and next step. You can release your own root with `release_convergence_root`; another session's root can be released only when its owner is not online and the user has decided to release it.

## Usage

### Ask as usual

Describe the work and what should be checked. The agent compares the installed skills' descriptions and applicability rules with your request and picks the skills it needs.

```text
Implement and verify this feature. First define the change scope and acceptance criteria.
In the final result, include the checks you actually ran and any unresolved issues.
```

To name a skill yourself, use `$orchestrator` in Codex or `/agent-governance-suite:orchestrator` in Claude Code. Skill-classification advice (`classify_skills`) works only where classification is configured, and the agent always makes the final choice.

### Collaborate across sessions

Sessions collaborate on the same computer under the same OS user. A session finds another session's host, session ID, and current work on the board (`list_session_status`) and sends a PEER message with `send_session_message`. Each message has a system-issued ID, and sending, body delivery, and acknowledgment (ACK) are recorded separately. **An ACK only confirms that the message was processed; it does not mean the work is done or that anything was approved.** If the recipient is offline, the sender does not stop to wait; it continues with work that does not need the reply.

Messages are delivered at the recipient's tool boundaries or turn end. Whether an idle session can be woken depends on the host.

| Host | Waking an idle session |
| --- | --- |
| Claude Code | Supported by default (`claude-inbox`). |
| Codex | Off by default: delivery is deferred (`codex-deferred`). Turn on [queue wake](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/input-boundaries.md#codex-queue-wake-설정) to wake idle sessions. |
| Antigravity | Wakes through the queue when Antigravity's runtime information is available. Turn it on or off with `AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE`. |

To see it work, open the same project in two sessions and give them these requests. No code is changed.

```text
[Review session]
Record your current work on the AGS board as "AGS-DEMO-REVIEW · Review test instructions".
When a PEER message asks for a review, read the referenced files yourself and check the explanation.
Leave an ACK, then send your result and evidence back in a separate PEER message.
Do not modify files or run tests.

[Research session]
Find how to run this project's tests in its documentation and configuration, and list the command
and the supporting files. Find the session handling "AGS-DEMO-REVIEW" on the board, ask it for a review
in a PEER message, and report the ACK and the actual review result separately.
Do not modify files or run tests.
```

If a message does not arrive, check `get_session_message_status` with the same `messageId`. Do not resend a message with an uncertain outcome under a new ID. The [message lifecycle](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/session-message-lifecycle.md) explains each status.

## Skills

Versions and provenance of the 24 specialist skills follow the [registry](skills/registry.json) and the [source lock](skills/source-lock.json). Two more skills ship with them: [`orchestrator`](skills/orchestrator/), which connects the flow, and [`session-board`](skills/session-board/), which explains how to use the board. Work records are handled by MCP tools (`checkpoint_context`, `inspect_context`, `load_context`, `suppress_context_restore`, `purge_direct_context`) and hooks, not by a skill.

| Skill | Source | Version | What it does |
| --- | --- | --- | --- |
| [`instruction-scope-resolver`](skills/instruction-scope-resolver/) | AGS | 1.0.0 | Finds the instruction files that apply to a path and their precedence. |
| [`workspace-convention-profiler`](skills/workspace-convention-profiler/) | AGS | 1.0.0 | Surveys repository structure, conventions, and verification commands. |
| [`task-contract`](skills/task-contract/) | AGS | 1.1.0 | Turns goal, scope, acceptance criteria, risk, and authority into a task contract. |
| [`model-effort-advisor`](skills/model-effort-advisor/) | AGS | 0.1.0 | Checks whether the observed model and reasoning effort fit the task's difficulty and risk. |
| [`coordinate-subagents`](skills/coordinate-subagents/) | AGS | 1.1.0 | Decides whether to delegate and sets ownership, handoff context, and verification duties. |
| [`ponytail`](skills/ponytail/) | Based on [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/83b2cbc3bc50df3030c49d1dfe598ccefe850a85), modified by AGS | 4.10.0 | Chooses the smallest complete implementation that meets the requirements. |
| [`change-scope-guardian`](skills/change-scope-guardian/) | AGS | 1.0.0 | Compares the baseline with current changes to find out-of-scope files. |
| [`mutation-risk-preflight`](skills/mutation-risk-preflight/) | AGS | 1.0.3 | Checks target, approval, impact, and recovery right before a hard-to-reverse change. |
| [`independent-deliberation-panel`](skills/independent-deliberation-panel/) | AGS | 1.0.0 | Reviews contested decisions through independent viewpoints and rebuttals. |
| [`iteration-frame-auditor`](skills/iteration-frame-auditor/) | AGS | 1.0.0 | Audits whether repeated attempts have drifted from the original contract and premises. |
| [`acceptance-evidence-validator`](skills/acceptance-evidence-validator/) | AGS | 1.0.0 | Checks acceptance criteria against evidence from the actual result. |
| [`independent-audit-gate`](skills/independent-audit-gate/) | AGS | 1.0.0 | Has an auditor separate from the implementer check high-risk changes and their evidence. |
| [`blocker-diagnostician`](skills/blocker-diagnostician/) | AGS | 1.1.0 | Separates observations from hypotheses in repeated failures and picks the next discriminating check. |
| [`recovery-strategy-selector`](skills/recovery-strategy-selector/) | AGS | 0.2.0 | Compares recovery strategies for a diagnosed failure and prepares the handoff. |
| [`cs-engineering`](skills/cs-engineering/) | AGS | 0.2.0 | Applies CS principles to concurrency, database, messaging, algorithm, and performance problems as invariants and verification duties. |
| [`solid-design`](skills/solid-design/) | AGS | 0.1.0 | Applies SOLID to real module, contract, and adapter boundaries and proposes the smallest change. |
| [`prompt-engineering`](skills/prompt-engineering/) | AGS | 0.1.0 | Designs and diagnoses LLM prompts, instructions, and input templates and builds comparison cases. |
| [`ui-ux-design`](skills/ui-ux-design/) | AGS | 0.1.0 | Designs and reviews user flows, screens and interactions, accessibility, state and error handling, and large-list display on web, desktop, and mobile. |
| [`test-engineering`](skills/test-engineering/) | AGS | 0.1.0 | Designs test cases at requirement and code boundaries and checks that they catch defects. |
| [`code-review`](skills/code-review/) | AGS | 0.1.0 | Reviews a fixed diff or PR for real failure paths and separates defects, recommendations, and questions. |
| [`software-security-auditor`](skills/software-security-auditor/) | AGS | 0.1.0 | Audits attack paths, controls, and coverage gaps in web/API and CLI/MCP code. |
| [`evaluation-validity-auditor`](skills/evaluation-validity-auditor/) | AGS | 1.0.0 | Audits whether an evaluation's inputs, judging, and aggregation are fair and reproducible. |
| [`korean-prose-editor`](skills/korean-prose-editor/) | AGS | 0.1.0 | Edits and verifies Korean prose while preserving facts, numbers, links, and code. |
| [`codex-token-usage-analyzer`](skills/codex-token-usage-analyzer/) | AGS | 0.1.0 | Totals token usage per task and project from local Codex logs; not included in the Claude Code package. |

The engineering modules shared by `test-engineering` and `code-review` are described in [engineering-practices integration](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/engineering-practices.ko.md).

## State and updates

| Data | Location |
| --- | --- |
| Workflow state (`workflows.sqlite3`) and work records (`continuity.sqlite3`) | Claude Code: `${CLAUDE_PLUGIN_DATA}`. Other hosts: `%LOCALAPPDATA%\agent-governance-suite` on Windows, `~/Library/Application Support/agent-governance-suite` on macOS, `$XDG_STATE_HOME/agent-governance-suite` on Linux (default `~/.local/state/agent-governance-suite`) |
| Board (`session-board.sqlite3`) and messages (`session-messaging/`) | `~/.agent-governance-suite`, shared by all hosts |

Where default paths differ, for example in a sandbox, give every participating host the same absolute `AGENT_GOVERNANCE_SHARED_STATE_DIR`. All path variables are listed in the [operations guide](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/operations.md#상태-저장과-마이그레이션).

Stored content is plain JSON and never expires on its own. Keep secrets, personal data, and raw logs out of work records and stage results. To remove old state, preview candidates with `prepare_state_cleanup`, then pass the token you confirmed to `execute_state_cleanup` (finished workflows after 180 days, inactive work-record bodies after 30 days). A backup is taken before deletion and is never deleted automatically. See [retention and cleanup](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/state-cleanup.md).

When a newer public stable release exists, the MCP server mentions it once in a tool response; `check_for_updates` checks on demand. Nothing is installed automatically. To update, stop the existing AGS MCP and relay processes, install the new version with the steps above, and start a new session. In Codex, trust the hooks again in `/hooks`; for agy, close the app and install the new package. See [update and recovery](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/session-message-lifecycle.md#업데이트와-복구).

## What AGS does not guarantee

- **It is not a security boundary against processes running as the same OS user.** Such a process can read and change the state databases or call the MCP server directly. ([architecture](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/architecture.md#세션-메시지-저장소-broker-없음), [security policy](https://github.com/jaeseongs95/agent-governance-suite/blob/main/SECURITY.md))
- **It does not authenticate submitted evidence or identities.** Evidence `verified` flags, auditor identities, and user-approval references are checked only for format and consistency between stages.
- **The edit check counts only edit-tool calls.** Files changed by shell commands, files outside version control, and subagent edits are not counted, and the count restarts every turn.
- **Message delivery state is not a work result.** ACKs and wake attempts do not prove processing or completion, and a Codex session interrupted with Esc cannot be woken until the user resumes it.
- **The turn check does not force behavior.** Skill text the agent loaded earlier stays in the conversation and AGS cannot remove it. Subagents do not receive the skill target list; a fix is planned for the next release.
- **Verification is limited.** Real-host testing for 3.6.0 covered comparison runs on a Linux test server; a full real-host re-measurement and dual-Cloud verification are not claimed complete. The quality evaluation of `korean-prose-editor`'s current editing policy is also unfinished. ([3.6.0 release notes](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/release-notes-v3.6.0.md#검증), [roadmap](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/roadmap.md))

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Skills or MCP tools are missing | Start a new session after installing, make sure the plugin and MCP are enabled, and make sure the two language packages are not both enabled in the same host. |
| The MCP server does not start | Check that the host runs Node.js 24.0.0 or later, and read the MCP startup log. |
| In Codex, guidance, the board, or messages do nothing | Check that you trusted the AGS hooks in `/hooks`. |
| The agy install fails | Close the Antigravity app and install again. Install the release package, not the whole repository. |
| An edit is refused with a request to start a workflow | Call `start_workflow` with a goal, stages, acceptance criteria, and `writeTargets`, as in the example in the refusal. |
| `start_workflow` fails with `ROOT_CONFLICT` | Read the root and next step in `details`. Release your own root with `release_convergence_root`. |
| An execution-observation error such as `BINDING_REQUIRED` | Look up the host's cause code in the [execution-observation contract](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/host-execution-attestation.md). |
| Another session is missing from the board | Check that the other session's hooks run and that both hosts use the same shared-state path. |
| A message gets no response, or only an ACK | Check status with the same `messageId` and the receiving host's wake mode. Ask for the review result in a separate message. |
| Old behavior remains after an update | Check whether old AGS MCP or relay processes are still running, then reconnect as in the [update procedure](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/session-message-lifecycle.md#업데이트와-복구). |

## Documentation

The linked design and operations documents are mostly in Korean.

| Topic | Documents |
| --- | --- |
| Design and contracts | [Architecture](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/architecture.md), [Operations](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/operations.md) |
| Session collaboration | [Message lifecycle](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/session-message-lifecycle.md), [Input boundaries](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/input-boundaries.md), [Peer wait policy](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/peer-wait-policy.md) |
| Execution observation | [Execution observation and host wiring](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/host-execution-attestation.md) |
| State and security | [Retention and cleanup](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/state-cleanup.md), [Security policy](https://github.com/jaeseongs95/agent-governance-suite/blob/main/SECURITY.md) |
| Development and releases | [Contributing](https://github.com/jaeseongs95/agent-governance-suite/blob/main/CONTRIBUTING.md), [Development notes](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/development.md), [Release checklist](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/release.md), [Roadmap](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/roadmap.md) |

## License

[MIT License](LICENSE)
