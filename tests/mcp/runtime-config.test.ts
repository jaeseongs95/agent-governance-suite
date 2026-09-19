import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertDistinctDatabasePaths,
  resolveContinuityDatabasePath,
  resolveSessionBoardDatabasePath,
  resolveSessionMessageStateDirectory,
  resolveRegistryPath,
  resolveWorkflowDatabasePath,
} from "../../mcp-server/src/runtime-config.js";

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

describe("resolveContinuityDatabasePath", () => {
  it("uses the explicit continuity override", () => {
    const workingDirectory = join(tmpdir(), "continuity-working-directory");
    expect(resolveContinuityDatabasePath(
      { AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join("private", "context.sqlite3") },
      "linux",
      join(tmpdir(), "unused-home"),
      workingDirectory,
    )).toBe(join(workingDirectory, "private", "context.sqlite3"));
  });

  it("defaults beside a configured workflow database without sharing the file", () => {
    const workflowPath = join(tmpdir(), "governance-state", "workflows-custom.sqlite3");
    expect(resolveContinuityDatabasePath({ AGENT_GOVERNANCE_DB_PATH: workflowPath }, "linux"))
      .toBe(join(tmpdir(), "governance-state", "continuity.sqlite3"));
  });
});

describe("resolveSessionBoardDatabasePath", () => {
  it("uses the explicit board override", () => {
    const workingDirectory = join(tmpdir(), "board-working-directory");
    expect(resolveSessionBoardDatabasePath({ AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: "board.sqlite3" }, "linux", join(tmpdir(), "unused-home"), workingDirectory))
      .toBe(join(workingDirectory, "board.sqlite3"));
  });

  it("shares one board in the host-neutral home state directory", () => {
    const state = join(tmpdir(), "user-state");
    const home = join(tmpdir(), "shared-home");
    const moved = { AGENT_GOVERNANCE_DB_PATH: join(tmpdir(), "plugin-data", "workflows.sqlite3") };
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(resolveSessionBoardDatabasePath({ ...moved, XDG_STATE_HOME: state, LOCALAPPDATA: state }, platform, home))
        .toBe(join(home, ".agent-governance-suite", "session-board.sqlite3"));
      expect(resolveSessionMessageStateDirectory({ XDG_STATE_HOME: state, LOCALAPPDATA: state }, platform, home))
        .toBe(join(home, ".agent-governance-suite", "session-messaging"));
    }
  });

  it("uses a shared-root override for both shared features", () => {
    const sharedRoot = join(tmpdir(), "shared-state");
    const environment = { AGENT_GOVERNANCE_SHARED_STATE_DIR: sharedRoot };

    expect(resolveSessionBoardDatabasePath(environment, "win32"))
      .toBe(join(sharedRoot, "session-board.sqlite3"));
    expect(resolveSessionMessageStateDirectory(environment, "linux"))
      .toBe(join(sharedRoot, "session-messaging"));
  });

  it("keeps feature-specific overrides ahead of the shared root", () => {
    const workingDirectory = join(tmpdir(), "shared-working-directory");
    const environment = {
      AGENT_GOVERNANCE_SHARED_STATE_DIR: join(tmpdir(), "shared-state"),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: "board.sqlite3",
      AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: "messages",
    };

    expect(resolveSessionBoardDatabasePath(environment, "linux", join(tmpdir(), "unused-home"), workingDirectory))
      .toBe(join(workingDirectory, "board.sqlite3"));
    expect(resolveSessionMessageStateDirectory(environment, "linux", join(tmpdir(), "unused-home"), workingDirectory))
      .toBe(join(workingDirectory, "messages"));
  });

  it("rejects a relative shared-root override", () => {
    expect(() => resolveSessionBoardDatabasePath({ AGENT_GOVERNANCE_SHARED_STATE_DIR: "relative" }, "linux"))
      .toThrow(/absolute path/u);
  });
});

describe("assertDistinctDatabasePaths", () => {
  it("rejects the same database and Windows case aliases", () => {
    const databasePath = join(tmpdir(), "governance-state", "shared.sqlite3");
    expect(() => assertDistinctDatabasePaths(databasePath, databasePath)).toThrow(/different files/u);
    expect(() => assertDistinctDatabasePaths(databasePath.toUpperCase(), databasePath.toLowerCase(), "win32")).toThrow(/different files/u);
  });

  it("allows separate in-memory connections", () => {
    expect(() => assertDistinctDatabasePaths(":memory:", ":memory:")).not.toThrow();
  });

  it("rejects paths whose parent directories resolve through a symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-path-alias-"));
    const realDirectory = join(directory, "real");
    const aliasDirectory = join(directory, "alias");
    try {
      await mkdir(realDirectory);
      await symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
      expect(() => assertDistinctDatabasePaths(
        join(realDirectory, "shared.sqlite3"),
        join(aliasDirectory, "shared.sqlite3"),
      )).toThrow(/different files/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
