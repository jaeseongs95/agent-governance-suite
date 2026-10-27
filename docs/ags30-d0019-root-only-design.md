# AGS 3.0 root-only hook contract

Only a session root may call AGS tools. Every advertised tool passes the same
server proof gate, including read-only tools and session-board listing. A root
proof does not replace a tool's own validation, execution attestation or approval.

## Actor contract and current support

Adapters return `role: root | child | indeterminate`,
`basis: observed | inferred | unavailable`, and a diagnostic `reasonCode`.
The common `actorAccess` function accepts root with observed or inferred basis.
Child, indeterminate and malformed observations are denied uniformly. Core policy
does not interpret vendor fields, product names or diagnostic label strings.

- Claude Code: a nonempty native `agent_id` means child/observed. A supported
  native event with a session ID and no `agent_id` means root/inferred, never
  root/observed. Empty or malformed IDs do not imply root. This also blocks
  in-process teammates that carry the child marker.
- Codex (3.0 stopgap): every recognized event with a session ID is root/inferred
  with `CODEX_ROOT_INFERRED_CHILD_GATE_DEFERRED`. Codex subagent hooks carry the
  parent session ID, so a subagent passes as its parent root. Blocking Codex
  children is deferred past 3.0 by user decision (2026-10-27). Until then the
  native capture and U3 rules below describe the later child gate, not a 3.0
  installation condition.
- Antigravity: 3.0 stopgap (user decision, 2026-10-28) infers root for every
  recognized event with a conversation ID, like Codex above, so a child passes
  as root until the child gate returns after 3.0. Antigravity PreToolUse carries
  no tool call ID, so the adapter draws a random one per hook run to keep the
  root proof one-use, and the connector refuses caller binding keys itself.
- Gemini CLI: unsupported in 3.0 because a discriminating actor observation is
  not established. Its adapter returns its own unsupported reason code; core
  policy has no host-specific exception.

Split-pane teammates and nested CLI processes are independent sessions and use
their own adapter's field rule. The initiating process cannot be reliably
identified by this mechanism. Team settings, environment markers, parent shell
commands, child counting and per-call CLI queries are not actor evidence.

The proposed temporary identity ID, alias, generation and compare-and-set
identity storage layer was withdrawn. It is not implemented.

## Call proof and failure behavior

One governance PreToolUse entry resolves the actor, executes the required domain
hook and then signs the resulting exact arguments. The proof binds the host,
session, native call ID, tool, argument digest, actor role/basis, issue time and
five-minute expiry. The server consumes it once through the existing atomic
workflow observation claim. Signature, scope, time or replay failures deny the
call. There is no new identity database, resident process or periodic work.

Caller-supplied `_sessionBinding` is rejected and is absent from advertised tool
schemas. The server derives internal domain bindings only after validating
`_sessionProof`. Missing proof denies `list_session_status` before board access;
it never means an unfiltered board listing.

Missing, timed-out or failed governance hooks cannot authorize a server call.
The Claude governance handler uses `onFailure: block` (Claude Code 2.1.295 or
later); its wrapper exits nonzero on import, execution or output failure.
Domain output that did not complete cannot be promoted into a root proof.

Wake liveness uses a version-3 signed digest of target, event, root role,
observed/inferred basis and nonce set. Diagnostic reasons are not authority or
digest inputs. Legacy 2.x receipts are rejected. Peer origin, authority `none`,
signature, nonce, target, freshness and historical timing checks remain required.

## Native evidence and release conditions

Synthetic tests exercise the common contract and denial paths; they are not
native captures. Each native fixture must retain producer version, capture time
and original hash. Codex evidence requires main PreToolUse, at least one built-in
child and one custom child PreToolUse, and the first record of each referenced
transcript. No unrelated conversation or complete transcript is required.

U3 is accepted only if the child hook points to the child's own transcript and
its first record discriminates it from the main session. A child pointing to the
parent's record rejects U3. Any eventual implementation belongs in the Codex
adapter, uses a positive version-pinned match and reports basis `inferred`.
Read errors and format changes deny with a specific reason. A Codex upgrade
requires a fresh capture; there is no detection daemon or periodic monitor.

These hooks and local signing keys are not a security boundary against another
process running as the same OS user. Such a process can read plugin state or
invoke a hook with fabricated input. Signed hook observation is not direct-user
approval and must not be described as OS isolation.

For Codex child blocking (deferred past 3.0), installation of that gate remains
HOLD until the actual proof/failure-path tests, native captures, U3 disposition
and existing V5/V6/V10 release conditions are satisfied.
Source generation, a targeted PASS, full CI, native POST and independent release
acceptance are separate evidence scopes.
