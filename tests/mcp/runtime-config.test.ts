import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveRegistryPath, resolveWorkflowDatabasePath } from "../../mcp-server/src/runtime-config.js";

describe("resolveRegistryPath", () => {
  it("uses SKILL_REGISTRY_PATH when supplied", () => {
    expect(resolveRegistryPath({ SKILL_REGISTRY_PATH: "/tmp/custom/registry.json" })).toBe("/tmp/custom/registry.json");
  });

  it("locates skills/registry.json relative to the bundled entry point by default", () => {
    const entrypoint = pathToFileURL(
      join(tmpdir(), "agent-governance-suite", "mcp-server", "dist", "server.mjs")
    ).href;
    const path = normalize(resolveRegistryPath({}, entrypoint));

    expect(basename(path)).toBe("registry.json");
    expect(path).toContain(normalize("skills/registry.json"));
  });
});

describe("resolveWorkflowDatabasePath", () => {
  it("uses an absolute AGENT_GOVERNANCE_DB_PATH unchanged", () => {
    const databasePath = join(tmpdir(), "agent-governance-suite", "custom.sqlite3");

    expect(resolveWorkflowDatabasePath(
      { AGENT_GOVERNANCE_DB_PATH: databasePath },
      "linux",
      join(tmpdir(), "unused-home"),
      join(tmpdir(), "unused-working-directory"),
    )).toBe(databasePath);
  });

  it("resolves a relative AGENT_GOVERNANCE_DB_PATH from the working directory", () => {
    const workingDirectory = join(tmpdir(), "agent-governance-suite-workspace");

    expect(resolveWorkflowDatabasePath(
      { AGENT_GOVERNANCE_DB_PATH: join("state", "workflow.sqlite3") },
      "linux",
      join(tmpdir(), "unused-home"),
      workingDirectory,
    )).toBe(join(workingDirectory, "state", "workflow.sqlite3"));
  });

  it.each([
    {
      name: "Linux XDG state directory",
      platform: "linux" as const,
      environment: { XDG_STATE_HOME: join(tmpdir(), "xdg-state") },
      homeDirectory: join(tmpdir(), "linux-home"),
      expectedRoot: join(tmpdir(), "xdg-state"),
    },
    {
      name: "Windows local app data directory",
      platform: "win32" as const,
      environment: { LOCALAPPDATA: join(tmpdir(), "local-app-data") },
      homeDirectory: join(tmpdir(), "windows-home"),
      expectedRoot: join(tmpdir(), "local-app-data"),
    },
    {
      name: "macOS application support directory",
      platform: "darwin" as const,
      environment: {},
      homeDirectory: join(tmpdir(), "mac-home"),
      expectedRoot: join(tmpdir(), "mac-home", "Library", "Application Support"),
    },
  ])("uses the $name by default", ({ platform, environment, homeDirectory, expectedRoot }) => {
    expect(resolveWorkflowDatabasePath(environment, platform, homeDirectory))
      .toBe(join(expectedRoot, "agent-governance-suite", "workflows.sqlite3"));
  });

  it("falls back to the home state directory when Linux XDG_STATE_HOME is absent", () => {
    const homeDirectory = join(tmpdir(), "linux-home");

    expect(resolveWorkflowDatabasePath({}, "linux", homeDirectory))
      .toBe(join(homeDirectory, ".local", "state", "agent-governance-suite", "workflows.sqlite3"));
  });
});
