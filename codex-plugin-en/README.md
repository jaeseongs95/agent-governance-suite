# Agent Governance Suite

[한국어](https://github.com/jaeseongs95/agent-governance-suite/blob/main/README.md) | English

Agent Governance Suite (AGS) is a local plugin for Claude Code, Codex, and Antigravity (`agy`). It helps an agent use the specialist skills a request needs, carry multi-stage work through its acceptance criteria, and carry forward your corrections and unfinished work. It covers documents, research, decisions, guidance materials, and software work. All three hosts use the same MCP server and common rules; what differs per host, such as hook events, wake methods, and install formats, is handled by each host's adapter.

The Korean documents are the source of truth. The documents linked below are in Korean.

[Installation](#installation) · [Usage](#usage) · [Skills](#skills) · [Documentation](#documentation)

## What can I use it for?

| What you want to do | How AGS helps |
| --- | --- |
| Research and make decisions | Sorting out goals, constraints, and acceptance criteria; reviewing contested choices; checking claims against actual evidence |
| Write documents, guides, and service procedures | Checking reader and user flow and accessibility; prompt design; Korean prose editing that preserves facts |
| Build or fix software | Choosing a small implementation; design, testing, code review, and security review; diagnosing repeated failures |
| Continue across stages or sessions | Workflow progress, work records of corrections and unfinished work, the session board, and PEER messages |

## What it contains

- **Skills:** 23 specialist skills, `orchestrator` to connect them, and `session-board` for the session board
- **Local MCP server:** tools for workflows, work records, the session board, session messages, and state cleanup
- **Host hooks:** add guidance and observe edit targets at session, turn, and tool boundaries.
- **Local admin page:** you change settings that people decide, such as the global context, roles, JEV, and display language, by signing with a passkey. The default address is `http://localhost:47615/`.

Guidance being present does not mean the agent followed it or that the result was verified. What AGS does not guarantee is in [Usage](docs/user/usage.md#보장하지-않는-것).

## Installation

You need Node.js **24.0.0 or later** and the host's plugin feature. Install AGS in every host that should collaborate. You do not need to clone this repository or run `pnpm install` to use the plugin.

<!-- release-version:start -->
The current public release is `v4.0.0`, and the examples below install it. From 4.0.0, JEV is configured only on the admin page (see the upgrade notes in the [4.0.0 release notes](docs/release-notes/release-notes-v4.0.0.md), Korean). 3.x is not compatible with 2.x. Changes for each version are in [GitHub Releases](https://github.com/jaeseongs95/agent-governance-suite/releases) and `docs/release-notes/release-notes-v<version>.md` (Korean).
<!-- release-version:end -->

If AGS is already installed, follow [Updates and migration](docs/user/update.md).

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
codex plugin marketplace add jaeseongs95/agent-governance-suite --ref v4.0.0
codex plugin add agent-governance-suite@agent-governance
```
<!-- release-install:end -->

Start a new Codex session, then review and trust the AGS hooks in `/hooks`. Until you do, Codex does not run plugin hooks, so the turn check, work records, the board, and message delivery do not work. Review them again after an update that changes the hook definitions.

### Antigravity (`agy`)

`agy plugin install` accepts only a local directory. Download the install package attached to the release, extract it, and install that directory. The package holds only the files agy reads; installing the whole repository can freeze the Antigravity app's installed-plugins view. Close the Antigravity app while installing; if it is running, the install cannot remove the old plugin folder and fails. On Windows, extract with `Expand-Archive`.

<!-- release-agy:start -->
```bash
curl -LO https://github.com/jaeseongs95/agent-governance-suite/releases/download/v4.0.0/agent-governance-suite-antigravity-v4.0.0.zip
unzip agent-governance-suite-antigravity-v4.0.0.zip
agy plugin install ./agent-governance-suite
agy plugin list
```
<!-- release-agy:end -->

For the Antigravity native app without the `agy` CLI, follow the [official manual installation guide](https://antigravity.google/docs/plugins#manual-plugin-installation). Close the app normally and keep the existing AGS folder outside the plugin discovery paths for recovery. Place the `agent-governance-suite` folder from the Antigravity installation ZIP attached to the release under `~/.gemini/config/plugins/` (Windows: `%USERPROFILE%/.gemini/config/plugins/agent-governance-suite`), restart the app, and check the AGS version in `Customizations > Installed`. Do not copy the whole repository. This method does not require installing the CLI.

The package includes the MCP server registration (`mcp_config.json`, server name `ags`, `AGENT_GOVERNANCE_HOST_ATTESTATION=antigravity`) and the hooks (`hooks.json`), so there is nothing else to configure. `GEMINI.md` and `AGENTS.md` in this repository are instructions for developing AGS itself and are not in the package.

### After installation

- In a new session, check that the AGS skills and MCP tools appear. If they do not, see [Troubleshooting](docs/user/troubleshooting.md).
- Open the admin page (`http://localhost:47615/`) and register the first passkey. The first key is accepted without confirmation, so register it early. [Admin page and contexts](docs/user/admin-page.md)

## Usage

Tell the agent the result you want, the conditions to check, and what must not change. You do not need to name a skill or a workflow in every request. The agent matches the request's purpose against each skill's use and exclusion conditions and uses a workflow for changes that run over several stages.

```text
Implement and verify this feature. First set out the scope and the acceptance criteria,
and in the final result list the checks you actually ran and the problems still unresolved.
```

What changes after installation, workflows and the edit gate, and work records are in [Usage](docs/user/usage.md); collaboration across sessions is in [Session collaboration](docs/user/collaboration.md).

## Skills

The versions and sources of the 23 specialist skills follow the [registry](skills/registry.json) and the [source lock](skills/source-lock.json). In addition, [`orchestrator`](skills/orchestrator/) connects the flow and [`session-board`](skills/session-board/) describes how to use the board. Work records are handled by MCP tools and hooks, not by a skill.

| Skill | Source | Version | What it does |
| --- | --- | --- | --- |
| [`instruction-scope-resolver`](skills/instruction-scope-resolver/) | AGS | 1.0.0 | Finds the instruction files that apply to a path and their precedence. |
| [`workspace-convention-profiler`](skills/workspace-convention-profiler/) | AGS | 1.0.0 | Surveys repository structure, conventions, and verification commands. |
| [`task-contract`](skills/task-contract/) | AGS | 1.1.0 | Turns goal, scope, acceptance criteria, risk, and authority into a task contract. |
| [`model-effort-advisor`](skills/model-effort-advisor/) | AGS | 0.2.0 | Selects a model and reasoning effort for an approved subagent assignment before dispatch, using task requirements and host-supported combinations. |
| [`coordinate-subagents`](skills/coordinate-subagents/) | AGS | 1.1.0 | Decides whether to delegate and sets ownership, handoff context, and verification duties. |
| [`minimal-implementation`](skills/minimal-implementation/) | AGS | 1.0.0 | For any deliverable (code, documents, data, settings, procedures), chooses the smallest complete result that contains only what is needed, and never reports a pass produced by a substitute as done. |
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

When to use which skill is in [Usage](docs/user/usage.md#스킬을-쓰는-시점).

## Documentation

| Audience | Documents (Korean) |
| --- | --- |
| Users | [Usage](docs/user/usage.md), [Admin page and contexts](docs/user/admin-page.md), [Session collaboration](docs/user/collaboration.md), [State storage and cleanup](docs/user/state.md), [Updates and migration](docs/user/update.md), [Troubleshooting](docs/user/troubleshooting.md) |
| Contributors | [Contributing](CONTRIBUTING.md), [Architecture](docs/contributing/architecture.md), [Development](docs/contributing/development.md), [Testing and CI](docs/contributing/testing-and-ci.md), [Releasing](docs/contributing/release.md) |
| Full list | [Documentation index](docs/README.md), [Archive](docs/archive/README.md), [Release notes](docs/release-notes/), [Security policy](SECURITY.md) |

## License

[MIT License](LICENSE)
