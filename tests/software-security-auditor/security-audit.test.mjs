import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest, targetDigest, validateSemantics } from "../../skills/software-security-auditor/scripts/core.mjs";
import { snapshot, validateReport, validateReportSchema } from "../../skills/software-security-auditor/scripts/validation.mjs";
import { fixture, finding, source } from "./fixture.mjs";

const temporary = [];
const repo = fileURLToPath(new URL("../../", import.meta.url));
function root() { const value = mkdtempSync(path.join(tmpdir(), "security-audit-")); temporary.push(value); writeFileSync(path.join(value, "target.txt"), source); return value; }
afterEach(() => { for (const item of temporary.splice(0)) rmSync(item, { recursive: true, force: true }); });
const rebind = (report) => { report.requestDigest = digest(report.request); report.targetDigest = targetDigest(report.request); report.evidence.forEach((e) => { e.targetDigest = report.targetDigest; }); };

describe("security audit evidence contract", () => {
  it("accepts complete research containing a confirmed high finding", () => {
    const { request, report } = fixture(); report.findings.push(finding());
    const dir = root();
    expect(validateReport(request, report, { targetRoot: dir, evidenceRoot: dir })).toEqual([]);
  });
  it.each(["tool unavailable", "configuration missing", "reproduction timeout"])("preserves partial coverage: %s", (reason) => {
    const { report } = fixture();
    report.request.checks.push({ id: "C2", description: "runtime condition" });
    report.checks.push({ id: "C2", status: "not-checked", method: "not-executed", evidenceRefs: [], observation: reason });
    report.status = "partial"; report.limitations = [reason]; rebind(report);
    expect(validateReportSchema(report)).toBe(true); expect(validateSemantics(report)).toEqual([]);
    report.status = "complete"; expect(validateSemantics(report)).toContain("STATUS_COVERAGE_MISMATCH");
  });
  it("accepts blocked only when meaningful checks are unavailable", () => {
    const { report } = fixture(); Object.assign(report.checks[0], { status: "not-checked", method: "not-executed", evidenceRefs: [] });
    report.status = "blocked"; report.limitations = ["missing runtime"];
    expect(validateSemantics(report)).toEqual([]);
  });
  it.each([
    ["duplicate check", (r) => r.checks.push(r.checks[0]), "DUPLICATE_CHECK"],
    ["missing check", (r) => { r.checks = []; }, "CHECK_INVENTORY_MISMATCH"],
    ["unknown ref", (r) => { r.checks[0].evidenceRefs = ["missing"]; }, "UNKNOWN_EVIDENCE"],
    ["duplicate evidence", (r) => r.evidence.push(r.evidence[0]), "DUPLICATE_EVIDENCE"],
    ["unexecuted check", (r) => { r.checks[0].method = "not-executed"; }, "CHECK_WITHOUT_EVIDENCE"],
    ["stale evidence", (r) => { r.evidence[0].targetDigest = `sha256:${"0".repeat(64)}`; }, "STALE_EVIDENCE"],
    ["unverified finding", (r) => { r.findings = [{ ...finding(), proof: "unverified" }]; }, "UNVERIFIED_CONFIRMED_FINDING"],
    ["unauthorized execution", (r) => { r.checks[0].method = "local-reproduction"; }, "UNAUTHORIZED_REPRODUCTION"],
  ])("rejects %s", (_name, mutate, expected) => { const { report } = fixture(); mutate(report); expect(validateSemantics(report)).toContain(expected); });
  it("binds actual uncommitted bytes and rejects target/evidence changes", () => {
    const dir = root(); const { request, report } = fixture();
    expect(snapshot(request, dir).targetDigest).toBe(report.targetDigest);
    writeFileSync(path.join(dir, "target.txt"), "changed");
    const errors = validateReport(request, report, { targetRoot: dir, evidenceRoot: dir });
    expect(errors).toContain("STALE_TARGET"); expect(errors).toContain("STALE_EVIDENCE");
    expect(snapshot(request, dir).targetDigest).not.toBe(report.targetDigest);
  });
  it("rejects a report for a different external request", () => {
    const dir = root(); const { request, report } = fixture(); const external = structuredClone(request); external.environment = "other";
    expect(validateReport(external, report, { targetRoot: dir, evidenceRoot: dir })).toContain("REQUEST_BINDING_MISMATCH");
  });
  it.each(["../outside", "/absolute", "C:/windows", "dir\\file", "file:stream"])("rejects unsafe locator %s", (locator) => {
    const dir = root(); const { request } = fixture(); request.target.files[0].path = locator;
    expect(() => snapshot(request, dir)).toThrow("UNSAFE_PATH");
  });
  it("rejects an external directory symlink/junction", () => {
    const dir = root(); const outside = root(); symlinkSync(outside, path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    const { request } = fixture(); request.target.files[0].path = "link/target.txt";
    expect(() => snapshot(request, dir)).toThrow("PATH_ESCAPE");
  });
  it.each([".", "claude-plugin"])("runs positive and negative CLI in node_modules-free %s packaging", (tree) => {
    const clean = root(); const from = path.join(repo, tree);
    for (const dir of ["runtime", "skills/software-security-auditor"]) { mkdirSync(path.dirname(path.join(clean, dir)), { recursive: true }); cpSync(path.join(from, dir), path.join(clean, dir), { recursive: true }); }
    const { request, report } = fixture(); writeFileSync(path.join(clean, "request.json"), JSON.stringify(request)); writeFileSync(path.join(clean, "report.json"), JSON.stringify(report));
    const args = [path.join(clean, "skills/software-security-auditor/scripts/cli.mjs"), "validate", "--input", path.join(clean, "request.json"), "--report", path.join(clean, "report.json"), "--target-root", clean, "--evidence-root", clean];
    const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    let result = spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 10000, windowsHide: true });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    writeFileSync(path.join(clean, "target.txt"), "tampered");
    result = spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 10000, windowsHide: true });
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout).errors).toContain("STALE_TARGET");
  });
});
