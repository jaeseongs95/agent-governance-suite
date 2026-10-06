You are a release-verification host session. Use ONLY the MCP tools of the installed plugin server "agent-governance-suite" (tool names start with mcp__plugin_agent-governance-suite_agent-governance-suite__). Do not write scripts that call the server, do not edit any file except the single mutation step below, and do not invent, add or remove fields like executionContext or observation tokens: the plugin hook supplies execution observations. If a call fails, report the exact error JSON and continue with the next independent flow. Do not retry by deleting unknown fields.

All prepared inputs are JSON files; read them with the Read tool and pass their contents verbatim as tool arguments.

FLOW F1B (dir /root/cs2x-final-20261006T054615Z/flow/f1b):
1. plan_workflow {schemaVersion:"1.0.0", taskEnvelope:<_args-task.json>}. Report the selected skills/providers and phaseOrders.
2. open_convergence_root {schemaVersion:"1.0.0", parentRootId:null, taskEnvelope:<task>, frame:<_args-frame.json>, userApprovalRefs:[]}
3. claim_workflow_attempt {schemaVersion:"1.0.0", rootId, expectedRevision:<root revision>, taskEnvelope, frame, plan:<plan data from step 1>, actorId:"claude-final-f1b", outputTargets:["candidate/queue.py"], priorFailure:null}
4. start_guarded_workflow {schemaVersion:"1.0.0", leaseId, expectedRootRevision:<claim data.rootRevision>, plan:<plan data>}
5. record_stage_result with the object in _args-stage-template.json, replacing runId, stageId (data.plan.stages[0].stageId) and expectedRevision (number) from step 4's data. Keep outputFile and output.output:null exactly.
6. finalize_workflow {runId, expectedRevision:<revision from step 5>}. Report final state.

FLOW R24B (dir /root/cs2x-final-20261006T054615Z/flow/r24b): repository-sized output through outputFile. Steps 1-6 as F1B with the r24b files (actorId "claude-final-r24b", outputTargets ["inventory.json"]). Use the r24b _args-stage-template.json for record_stage_result.

Finally print a compact JSON summary: for each flow, every tool called, ok/error code, runId, revision, state, and any executionContext.actorId / observationId visible in results.
