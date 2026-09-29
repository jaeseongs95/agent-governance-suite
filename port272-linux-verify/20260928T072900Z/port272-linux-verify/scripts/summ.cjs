const j=require(process.argv[2]);const s=[];
for(const f of j.testResults)for(const a of f.assertionResults)if(a.status!=="passed")s.push(a.status+" | "+f.name.replace(/^\/tmp\/(cand|base)\//,"")+" > "+a.fullName);
for(const f of j.testResults)if(f.status!=="passed"&&f.assertionResults.length===0)s.push("file-"+f.status+" | "+f.name+" | "+(f.message||"").slice(0,300));
console.log(`total=${j.numTotalTests} passed=${j.numPassedTests} failed=${j.numFailedTests} pending=${j.numPendingTests} todo=${j.numTodoTests} suites=${j.numTotalTestSuites}`);console.log(s.join("\n"));
