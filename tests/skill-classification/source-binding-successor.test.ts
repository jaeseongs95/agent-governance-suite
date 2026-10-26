import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {expect,it} from "vitest";
import {oracleDigest} from "./evaluation.js";
const root=fileURLToPath(new URL("../../",import.meta.url));
const current=JSON.parse(readFileSync(new URL("./fixtures.json",import.meta.url),"utf8"));
const side=JSON.parse(readFileSync(new URL("./fixtures.source-successor.json",import.meta.url),"utf8"));
const hash=(v:string|Buffer)=>"sha256:"+createHash("sha256").update(v).digest("hex");
const pinned={
  "predecessor": {
    "path": "tests/skill-classification/fixtures.json",
    "gitBlob": "af8424b81e3fbc495cbd5f628d3e3d2157e705a2",
    "bytes": 142477,
    "digest": "sha256:49d327a6dca9557312d90014410702f8466e839175b3187bc91693b6cccd4789",
    "fixtureRevision": "ags-classification-governance-source-binding-r03",
    "oracleRevision": "pre-live-governance-source-reviewed-r03",
    "oracleDigest": "sha256:96a7c48283c995dd79c662860b179298bd99d474c899d58820de17d7b8770239"
  },
  "historicalSidecarDigest": "sha256:69ef37b636e35bfdce77103cbe84015c0e2e9482a41e46059d89ac557a8717f7",
  "semanticDigest": "sha256:6700d30def96ecbc7869f52dd5ab05e417d3b6ef42dfa3e390361054ff8ad2aa",
  "bindings": [
    {
      "skillId": "session-board",
      "path": "skills/session-board/SKILL.md",
      "previousDigest": "sha256:b4c2226e35c277c53dd89305c31961f81a2f739bbca61f47d567c12462ea209a",
      "digest": "sha256:c23a8cebd2a794d9f281ba171f7dac073a5a91a68ceb9a26b748dd843a733bd2"
    }
  ],
  "reboundReferences": 1
};
function semantics(value:unknown,depth=0):unknown {
 if(Array.isArray(value))return value.map(v=>semantics(v,depth+1));
 if(value&&typeof value==="object") {const row=value as Record<string,unknown>;return Object.fromEntries(Object.entries(row).filter(([k])=>!(depth===0&&["fixtureRevision","oracleRevision","oracleDigest","sourceBindingRevision"].includes(k))&&!(k==="digest"&&row.skillId==="session-board"&&row.path==="skills/session-board/SKILL.md")).map(([k,v])=>[k,semantics(v,depth+1)]));}return value;
}
it("preserves the predecessor and frozen 39/18/21 corpus semantics",()=>{
 expect(side.predecessor).toEqual(pinned.predecessor);
 expect(hash(JSON.stringify(side.historicalSuccessor.document,null,2)+"\n")).toBe(pinned.historicalSidecarDigest);
 expect(side.historicalSuccessor.digest).toBe(pinned.historicalSidecarDigest);
 expect(hash(JSON.stringify(semantics(current)))).toBe(pinned.semanticDigest);
 expect(current.fixtureRevision).toBe("ags-classification-host-source-binding-r04");
 expect(current.cases).toHaveLength(39);expect(current.cases.filter((v:{oracle:unknown})=>v.oracle!==null)).toHaveLength(18);
 expect(current.cases.filter((v:{publicSynthetic:boolean;originalPrompt:string})=>v.publicSynthetic&&v.originalPrompt)).toHaveLength(21);
 expect(oracleDigest(current)).toBe(current.oracleDigest);expect(current.oracleDigest).toBe(side.successor.oracleDigest);expect(current.status).toBe("NOT_RUN");
});
it("binds exactly one session board source reference without changing selection semantics",()=>{
 expect(side.bindings).toEqual(pinned.bindings);let count=0;
 const walk=(v:unknown)=>{if(!v||typeof v!=="object")return;const row=v as Record<string,unknown>;if(row.skillId==="session-board"&&row.path==="skills/session-board/SKILL.md"&&"digest" in row){expect(row.digest).toBe(pinned.bindings[0]!.digest);count++;}for(const x of Object.values(row))walk(x);};walk(current);
 expect(count).toBe(pinned.reboundReferences);expect(count).toBe(side.reboundReferences);
 expect(hash(readFileSync(path.join(root,pinned.bindings[0]!.path)))).toBe(pinned.bindings[0]!.digest);
});
