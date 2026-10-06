You are a release-verification host session. Use ONLY the MCP tools of the installed plugin server "agent-governance-suite" (tool names start with mcp__plugin_agent-governance-suite_agent-governance-suite__). Do not write scripts that call the server, do not edit any file except the single mutation step below, and do not invent, add or remove fields like executionContext or observation tokens: the plugin hook supplies execution observations. If a call fails, report the exact error JSON and continue with the next independent flow. Do not retry by deleting unknown fields.

All prepared inputs are JSON files; read them with the Read tool and pass their contents verbatim as tool arguments.

FLOW F1 (dir /root/cs2x-final-20261006T054615Z/flow/f1):
1. plan_workflow {schemaVersion:"1.0.0", taskEnvelope:<_args-task.json>}. Report the selected skills/providers and phaseOrders.
2. open_convergence_root {schemaVersion:"1.0.0", parentRootId:null, taskEnvelope:<task>, frame:<_args-frame.json>, userApprovalRefs:[]}
3. claim_workflow_attempt {schemaVersion:"1.0.0", rootId, expectedRevision:<root revision>, taskEnvelope, frame, plan:<plan data from step 1>, actorId:"claude-final-f1", outputTargets:["candidate/queue.py"], priorFailure:null}
4. start_guarded_workflow {schemaVersion:"1.0.0", leaseId, expectedRootRevision:<claim data.rootRevision>, plan:<plan data>}
5. record_stage_result with the object in _args-stage-template.json, replacing runId, stageId (data.plan.stages[0].stageId) and expectedRevision (number) from step 4's data. Keep outputFile and output.output:null exactly.
6. finalize_workflow {runId, expectedRevision:<revision from step 5>}. Report final state.

FLOW NEG (dir /root/cs2x-final-20261006T054615Z/flow/neg): do steps 1-5 exactly as F1 using the neg files and actorId "claude-final-neg". Then run this Bash command once:
  python3 /root/cs2x-final-20261006T054615Z/scripts/mutate1byte.py /root/cs2x-final-20261006T054615Z/flow/neg/review.json
Then finalize_workflow for the neg run. It is expected to be rejected; report the exact result.

FLOW R24 (dir /root/cs2x-final-20261006T054615Z/flow/r24): repository-sized output through outputFile. Steps 1-6 as F1 with the r24 files (actorId "claude-final-r24", outputTargets ["inventory.json"]). Use the r24 _args-stage-template.json for record_stage_result.

FLOW SUB: use the Agent tool to launch ONE general-purpose subagent with this instruction: "Read /root/cs2x-final-20261006T054615Z/flow/f1/_args-task.json and call the MCP tool mcp__plugin_agent-governance-suite_agent-governance-suite__plan_workflow exactly once with {schemaVersion:'1.0.0', taskEnvelope:<file content>}. Return the full JSON result verbatim. Do nothing else." Report what it returned.

Finally print a compact JSON summary: for each flow, every tool called, ok/error code, runId, revision, state, and any executionContext.actorId / observationId visible in results.
