import json,sys
# prints failing/skipped tests from a vitest JSON report
for f in sys.argv[1:]:
    d=json.load(open(f))
    print(f, "pass",d["numPassedTests"],"fail",d["numFailedTests"],"skip",d.get("numPendingTests",0)+d.get("numTodoTests",0))
    for tr in d["testResults"]:
        for a in tr["assertionResults"]:
            if a["status"]=="failed":
                print("  FAIL", tr["name"].split("/tmp/")[-1], "::", a["fullName"], "loc=",a.get("location"))
                print("   ", (a["failureMessages"] or [""])[0][:600].replace("\n","\n    "))
        if tr["status"]=="failed" and not any(a["status"]=="failed" for a in tr["assertionResults"]):
            print("  FILEFAIL", tr["name"], tr.get("message","")[:600])
