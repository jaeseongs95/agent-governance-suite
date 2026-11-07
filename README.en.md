# Agent Governance Suite

[한국어](https://github.com/jaeseongs95/agent-governance-suite/blob/main/README.md) | English

Agent Governance Suite (AGS) is a local plugin for Claude Code, Codex, and Antigravity (`agy`). It helps an agent use the specialist skills a request needs, carry multi-stage work through its acceptance criteria, and carry forward your corrections and unfinished work. It covers documents, research, decisions, guidance materials, and software work.

This README **includes changes in the 3.8 work in progress. 3.8 has not been published.** The installation commands below target the current public stable release. Check the release notes for the version you install.

[Usage](#usage) · [Installation](#installation) · [What changes after installation](#what-changes-after-installation) · [Work records and collaboration](#work-records-and-collaboration) · [Skills](#skills) · [What AGS does not guarantee](#what-ags-does-not-guarantee) · [Troubleshooting](#troubleshooting) · [Documentation](#documentation)

## What can I use it for?

| Your goal | How AGS helps |
| --- | --- |
| Research material and make decisions | Define goals, constraints, and acceptance criteria; examine contested choices; compare claims with evidence |
| Create documents, guidance, or service procedures | Review the audience's journey and accessibility; design prompts; edit Korean prose while preserving facts |
| Build or repair software | Choose a small implementation; examine design, tests, code, and security; distinguish causes of repeated failures |
| Continue across stages or sessions | Track workflow progress, save corrections and remaining work, and collaborate through a session board and PEER messages |

AGS includes 23 specialist skills, `orchestrator` to connect their work, and `session-board` to explain the shared board. A local MCP server provides workflow and record tools. Host hooks add guidance and observations at session, turn, and tool boundaries. The presence of guidance does not establish that the agent followed it or that the result was verified.

## Usage

### Ask as usual

Describe the result, how it should be checked, and what must stay unchanged. You do not need to name a skill or workflow in every request. The agent compares your goal with the skills' applicability and exclusions, and uses workflows for changes that span stages. Questions, explanations, and work that fits one specialist stay within that scope.

```text
Revise this notice so that a first-time visitor can complete a booking.
Preserve the booking terms and contact details. Write the verification cases before changing it.
Separate what you actually checked from what still needs a person's review.
```

```text
Implement and verify this feature. First define the change scope and acceptance criteria.
In the final result, include the checks you actually ran and any unresolved issues.
```

To name a skill yourself, use `$orchestrator` in Codex or `/agent-governance-suite:orchestrator` in Claude Code. Skill-classification advice (`classify_skills`) works only where classification is configured; the agent makes the final choice.

### What changes after installation

| When | What AGS does |
| --- | --- |
| Start, resume, and after compaction | Offers the skill-selection and workflow rules. On resume or after compaction, existing hooks inject the current-memory body; `load_context` can read the caller's current body and token when needed. Workflow summaries and structural cards keep their separate contract. Guidance output and actual model consumption or compliance are separate evidence. |
| Every user message | Adds a turn check and the installed skills' targets to prompt reconsideration. The notice also asks the agent to save corrections, decisions, approvals, prohibitions, and remaining work with `checkpoint_context`. |
| Subagent start | Claude Code and Codex SubagentStart hooks supply skill targets and a reminder to respect the assignment's scope, forbidden areas, and write ownership. agy has no equivalent start hook. |
| File changes | Compares paths reported by the host with workflow write scopes. Product files without a workflow, and product files outside active workflow scopes, count in a window between workflow starts or turn-end checks; calls reaching the third distinct file are refused. A root waiting for review or a user decision has a separate refusal rule. See the limits below. |
| Stage results and turn end | Workflow tools check stage results and unresolved items. After product-file edits, unfinished stages trigger guidance to continue. Recorded completion requires all planned stages to pass and no unresolved items; the truth of submitted evidence needs separate verification. |

### Model and reasoning choices for subagents

`model-effort-advisor` helps select a model and reasoning effort **before dispatching an already approved subagent assignment**, using its role, difficulty, risk, verifiability, and quality, speed, and cost preferences. Available preferences are `economy`, `balanced`, and `quality`; `balanced` is the default. It does not decide whether to delegate, agent count, permissions, or required audits. It does not observe the main model or change its UI settings.

The shared selection contract is vendor independent. Bundled catalogs currently have OpenAI/Codex, Anthropic/Claude Code, and Google/Gemini provider adapters, with separate execution-host entries for Claude Code, Codex, Gemini, and Antigravity. **A catalog entry does not prove availability in the current host.** Check the host's actual capabilities and invocation fields first. A Gemini catalog entry is not a declaration of a separate Gemini CLI installation package.

Record the requested choice, the arguments actually dispatched, and the effective settings observed from the host separately. A supported selection does not establish actual application. Leave hidden inherited settings unverified. For high-risk work, `general` and `high` or above are only recommended first; model class and reasoning effort never refuse delegation, result recording, or finalization. See [model routing and host application](skills/coordinate-subagents/references/model-routing.md).

## Installation

You need Node.js **24.0.0 or later** and plugin support in your host. Install AGS in every host that should take part. You do not need to clone this repository or run `pnpm install` to use the plugin.

<!-- release-version:start -->
The current public release is `v3.8.0`, and the examples below install it. 3.x is not compatible with 2.x. Changes for each version are in [GitHub Releases](https://github.com/jaeseongs95/agent-governance-suite/releases) and `docs/release-notes-v<version>.md` (Korean).
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
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v3.8.0
codex plugin add agent-governance-suite@agent-governance
```
<!-- release-install:end -->

Start a new Codex session, then review and trust the AGS hooks in `/hooks`. Until you do, Codex does not run plugin hooks, so the turn check, work records, the board, and message delivery do not work. Review them again after an update that changes the hook definitions.

### Antigravity (`agy`)

For the Antigravity native app without the `agy` CLI, follow the [official manual installation guide](https://antigravity.google/docs/plugins#manual-plugin-installation). Close the app normally and keep the existing AGS folder outside the plugin discovery paths for recovery. Place the `agent-governance-suite` folder from the Antigravity installation ZIP attached to the release under `~/.gemini/config/plugins/` (Windows: `%USERPROFILE%/.gemini/config/plugins/agent-governance-suite`), restart the app, and check the AGS version in `Customizations > Installed`. Do not copy the whole repository. This method does not require installing the CLI.

`agy plugin install` accepts only a local directory. Download the install package attached to the release, extract it, and install that directory. The package holds only the files agy reads; installing the whole repository can freeze the Antigravity app's installed-plugins view. Close the Antigravity app while installing; if it is running, the install cannot remove the old plugin folder and fails. On Windows, extract with `Expand-Archive`.

<!-- release-agy:start -->
```bash
curl -LO https://github.com/jaeseongs95/agent-governance-suite/releases/download/v3.8.0/agent-governance-suite-antigravity-v3.8.0.zip
unzip agent-governance-suite-antigravity-v3.8.0.zip
agy plugin install ./agent-governance-suite
agy plugin list
```
<!-- release-agy:end -->

The package already contains the MCP server registration (`mcp_config.json`, server name `ags`, `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`) and the hooks (`hooks.json`), so there is nothing else to configure. `GEMINI.md` and `AGENTS.md` in this repository are guidelines for developing AGS itself and are not part of the package.

## Work records and collaboration

### Continue unfinished work

The agent saves corrections, decisions, and remaining work, then compares the original record with the current state when it resumes. Work records do not duplicate the workflow stage ledger. A saved summary does not replace checking actual files, environments, and test results. Keep secrets and personal logs out of records.

If you assigned a role, the agent records it with its current work on the board. Guidance asks it to hand requests outside its role to the responsible session. A board role is neither access control nor execution approval.

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

## State and updates

**Before upgrading to 3.8.0, follow the [existing-data backup, migration, and recovery guide (Korean)](https://github.com/jaeseongs95/agent-governance-suite/blob/v3.8.0/docs/migrate-to-v3.8.0.md).**

| Data | Location |
| --- | --- |
| Workflow state (`workflows.sqlite3`) and work records (`continuity.sqlite3`) | Claude Code: `${CLAUDE_PLUGIN_DATA}`. Other hosts: `%LOCALAPPDATA%\agent-governance-suite` on Windows, `~/Library/Application Support/agent-governance-suite` on macOS, `$XDG_STATE_HOME/agent-governance-suite` on Linux (default `~/.local/state/agent-governance-suite`) |
| Board (`session-board.sqlite3`) and messages (`session-messaging/`) | `~/.agent-governance-suite`, shared by all hosts |

Where default paths differ, for example in a sandbox, give every participating host the same absolute `AGENT_GOVERNANCE_SHARED_STATE_DIR`. All path variables are listed in the [operations guide](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/operations.md#상태-저장과-마이그레이션).

Work-record bodies and stage results are stored without encryption in the local databases; the retention periods below do not delete them automatically. Keep secrets, personal data, and raw logs out of work records and stage results. To remove old state, preview candidates with `prepare_state_cleanup`, then pass the token you confirmed to `execute_state_cleanup` (finished workflows after 180 days, inactive work-record bodies after 30 days). A backup is taken before deletion and is never deleted automatically. See [retention and cleanup](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/state-cleanup.md).

When a newer public stable release exists, the MCP server mentions it once in a tool response; `check_for_updates` checks on demand. Nothing is installed automatically. To update, stop the existing AGS MCP and relay processes, install the new version with the steps above, and start a new session. In Codex, trust the hooks again in `/hooks`; for agy, close the app and install the new package. See [update and recovery](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/session-message-lifecycle.md#업데이트와-복구).

### Local processes and message storage

Each AGS messaging process opens the shared SQLite file directly. AGS does not install a separate message-broker server, TCP listener, broker certificate, or broker token. A **relay process can run** to track session liveness and wake it for messages. The relay is tied to the host process and its lease, so this does not mean there are no background processes. Networking by the host or external model services is separate from this messaging-store design.

## Skills

Versions and provenance of the 23 specialist skills follow the [registry](skills/registry.json) and the [source lock](skills/source-lock.json). Two more skills ship with them: [`orchestrator`](skills/orchestrator/), which connects the flow, and [`session-board`](skills/session-board/), which explains how to use the board. Work records are handled by MCP tools (`checkpoint_context`, `inspect_context`, `load_context`, `suppress_context_restore`, `purge_direct_context`) and hooks, not by a skill.

| Skill | Source | Version | What it does |
| --- | --- | --- | --- |
| [`instruction-scope-resolver`](skills/instruction-scope-resolver/) | AGS | 1.0.0 | Finds the instruction files that apply to a path and their precedence. |
| [`workspace-convention-profiler`](skills/workspace-convention-profiler/) | AGS | 1.0.0 | Surveys repository structure, conventions, and verification commands. |
| [`task-contract`](skills/task-contract/) | AGS | 1.1.0 | Turns goal, scope, acceptance criteria, risk, and authority into a task contract. |
| [`model-effort-advisor`](skills/model-effort-advisor/) | AGS | 0.2.0 | Selects a model and reasoning effort for an approved subagent assignment before dispatch, using task requirements and host-supported combinations. |
| [`coordinate-subagents`](skills/coordinate-subagents/) | AGS | 1.1.0 | Decides whether to delegate and sets ownership, handoff context, and verification duties. |
| [`ponytail`](skills/ponytail/) | Based on [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/83b2cbc3bc50df3030c49d1dfe598ccefe850a85), modified by AGS | 4.10.0 | Chooses the smallest complete implementation that meets the requirements. |
| [`change-scope-guardian`](skills/change-scope-guardian/) | AGS | 1.0.0 | Compares the baseline with current changes to find out-of-scope files. |
| [`mutation-risk-preflight`](skills/mutation-risk-preflight/) | AGS | 1.0.3 | Checks target, approval, impact, and recovery right before a hard-to-reverse change. |
| [`independent-deliberation-panel`](skills/independent-deliberation-panel/) | AGS | 1.0.0 | Reviews contested decisions through independent viewpoints and rebuttals. |
| [`iteration-frame-auditor`](skills/iteration-frame-auditor/) | AGS | 1.0.0 | Audits whether repeated attempts have drifted from the original contract and premises. |
| [`acceptance-evidence-validator`](skills/acceptance-evidence-validator/) | AGS | 1.0.0 | Checks acceptance criteria against evidence from the actual result. |
| [`independent-audit-gate`](skills/independent-audit-gate/) | AGS | 1.0.0 | Has an auditor separate from whoever made the change check high-risk changes and their evidence. |
| [`blocker-diagnostician`](skills/blocker-diagnostician/) | AGS | 1.1.0 | Separates observations from hypotheses in repeated failures and picks the next discriminating check. |
| [`recovery-strategy-selector`](skills/recovery-strategy-selector/) | AGS | 0.2.0 | Compares recovery strategies for a diagnosed failure and prepares the handoff. |
| [`cs-engineering`](skills/cs-engineering/) | AGS | 0.2.0 | Applies CS principles to concurrency, database, messaging, algorithm, and performance problems as invariants and verification duties. |
| [`solid-design`](skills/solid-design/) | AGS | 0.1.0 | Applies SOLID to real module, contract, and adapter boundaries and proposes the smallest change. |
| [`prompt-engineering`](skills/prompt-engineering/) | AGS | 0.1.0 | Designs and diagnoses LLM prompts, instructions, and input templates and builds comparison cases. |
| [`ui-ux-design`](skills/ui-ux-design/) | AGS | 0.1.0 | Designs and reviews the user flow, information hierarchy, accessibility, and edge cases of anything people see and use (screens, print and ads, video, spaces and signage, products, service processes, documents and forms), checking first whether it works for the intended audience. |
| [`test-engineering`](skills/test-engineering/) | AGS | 0.1.0 | Designs test cases at requirement and code boundaries and checks that they catch defects. |
| [`code-review`](skills/code-review/) | AGS | 0.1.0 | Reviews a fixed diff or PR for real failure paths and separates defects, recommendations, and questions. |
| [`software-security-auditor`](skills/software-security-auditor/) | AGS | 0.1.0 | Audits attack paths, controls, and coverage gaps in web/API and CLI/MCP code. |
| [`evaluation-validity-auditor`](skills/evaluation-validity-auditor/) | AGS | 1.0.0 | Audits whether an evaluation's inputs, judging, and aggregation are fair and reproducible. |
| [`korean-prose-editor`](skills/korean-prose-editor/) | AGS | 0.1.0 | Edits and verifies Korean prose while preserving facts, numbers, links, and code. |

The engineering modules shared by `test-engineering` and `code-review` are described in [engineering-practices integration](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/engineering-practices.ko.md).

## What AGS does not guarantee

- **It is not a security boundary against processes running as the same OS user.** Such a process can read or change state databases or call the MCP server directly. Checking the format and consistency of evidence, auditor identities, and approval references does not authenticate them. [Architecture](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/architecture.md#세션-메시지-저장소-broker-없음) · [Security policy](https://github.com/jaeseongs95/agent-governance-suite/blob/main/SECURITY.md)
- **The edit check is not a filesystem-wide write monitor.** It handles supported edit tools, literal shell output redirections, and certain PowerShell writer paths. Observed child edits count in the parent session's window. It cannot discover all writes through arbitrary scripts, aliases, dynamic paths, or control flow. Files outside version control do not count toward the three-file threshold, but are checked against roots waiting for review or a user decision. An AGS infrastructure failure that prevents a check is recorded and reported rather than unconditionally blocking edits.
- **Guidance, skill calls, and successful tool responses are separate from completed behavior.** Turn checks do not force compliance or remove previously loaded skill text. AGS states delegation rules but does not inspect every delegation call. A model request or catalog is not evidence of effective settings.
- **Message ACKs and wake attempts are neither work results nor approvals.** Obtain the result and evidence separately. A Codex session interrupted with Esc cannot be woken until the user resumes it.

### How to read verification status

During 3.8 development, actual model pilots ran on Linux TEST through the official Claude Code and Codex paths. They observed real skill use, file changes, and some defect detection, while also finding **missing requirement-level cases before edits and temporary-file work outside the allowed scope**. A successful exit or CI run does not mean all behavior passed. [Claude follow-up result](v380-d36-t4-e071117f-result.ko.md) · [Work-record and consumer results](v380-qb-m23-result.ko.md) · [Multi-turn results](v380-qb-m456-result.ko.md)

Results do not transfer automatically between candidates, hosts, or CLI versions. Hook output, successful MCP responses, complete model input, and actual compliance need separate evidence. These results do not establish full model-input visibility, every admission path, every host/Cloud combination, or actual print and human usability. They also do not verify the advisor's new pre-dispatch path. Evaluation of the Korean editing policy and the quality of UX outputs is not claimed complete. [3.8 work notes](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/release-notes-v3.8.0.md#검증) · [3.7 verification](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/release-notes-v3.7.0.md#검증) · [3.6 verification](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/release-notes-v3.6.0.md#검증) · [Roadmap](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/roadmap.md)

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Skills or MCP tools are missing | Start a new session after installation, enable the plugin and MCP, and make sure both language packages are not enabled together. |
| The MCP server does not start | Check that the host runs Node.js 24.0.0 or later and inspect its MCP startup diagnostics. |
| Guidance, the board, or messages do nothing in Codex | Review and trust the AGS hooks in `/hooks`. |
| The agy installation fails | Close the app and install the release package, not the whole repository. |
| An edit is refused with a workflow request | Use the refusal's `start_workflow` example with a goal, stages, acceptance criteria, and `writeTargets`. Define a separate scope for work outside an existing workflow. |
| `ROOT_CONFLICT` prevents a start | Read the old root, state, and next step in `details`. Use `release_convergence_root` for your own root. Releasing another session's root requires its owner not to be online and a user decision. |
| The advisor holds a dispatch for missing support information | Check current host evidence for the model and effort. Do not infer effective settings from a catalog or request. |
| An execution-observation error such as `BINDING_REQUIRED` | Check the host-specific cause in the [execution-observation contract](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/host-execution-attestation.md). Model advice and execution eligibility are separate. |
| A peer is missing or sends only an ACK | Check hooks, the shared-state path, and the host's wake mode. Query the same `messageId` and obtain the work result separately. |
| Old behavior remains after an update | Check that the old AGS MCP and relay have ended, then reconnect in a new session as in the [update procedure](https://github.com/jaeseongs95/agent-governance-suite/blob/main/docs/session-message-lifecycle.md#업데이트와-복구). |

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
