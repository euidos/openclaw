import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveCanonicalRunRuntimeWorkspace,
  resolveRootedRunRuntimeWorkspace,
  resolveRunWorkspaceDir,
} from "./workspace-run.js";

vi.unmock("./agent-scope-config.js");

const workspace = (name: string) => path.join(process.cwd(), "tmp", `workspace-${name}`);
const defaultWorkspace = workspace("default-main");
const researchWorkspace = workspace("research");
const runConfig: OpenClawConfig = {
  agents: {
    defaults: { workspace: defaultWorkspace },
    entries: { main: {}, research: { workspace: researchWorkspace } },
  },
};
const resolve = (params: Partial<Parameters<typeof resolveRunWorkspaceDir>[0]> = {}) =>
  resolveRunWorkspaceDir({ config: runConfig, workspaceDir: undefined, ...params });

describe("rooted runtime workspace selection", () => {
  const canonical = path.resolve("/tmp/rooted-agent-workspace");
  const executionRoot = path.resolve("/tmp/rooted-task");
  const config: OpenClawConfig = {
    agents: { entries: { main: { workspace: canonical } } },
  };

  it.each([
    { bootstrapWorkspaceDir: canonical, expected: canonical },
    { bootstrapWorkspaceDir: executionRoot, expected: undefined },
    { bootstrapWorkspaceDir: undefined, expected: undefined },
  ])(
    "only borrows explicit canonical bootstrap $bootstrapWorkspaceDir",
    ({ bootstrapWorkspaceDir, expected }) => {
      expect(
        resolveRootedRunRuntimeWorkspace({
          config,
          agentId: "main",
          workspaceDir: executionRoot,
          bootstrapWorkspaceDir,
        })?.workspaceDir,
      ).toBe(expected);
    },
  );

  it.each([false, true])(
    "keeps same-workspace reload binding unless execution is confined (%s)",
    (confined) => {
      expect(
        resolveRootedRunRuntimeWorkspace({
          config,
          agentId: "main",
          workspaceDir: canonical,
          bootstrapWorkspaceDir: canonical,
          ...(confined ? { requireWorkspaceOnly: true, sessionRoot: canonical } : {}),
        })?.workspaceDir,
      ).toBe(confined ? canonical : undefined);
    },
  );

  it.each([undefined, {}])(
    "does not invent canonical ownership without a roster (%j)",
    (missingConfig) => {
      expect(
        resolveRootedRunRuntimeWorkspace({
          config: missingConfig,
          workspaceDir: executionRoot,
          bootstrapWorkspaceDir: canonical,
        }),
      ).toBeUndefined();
      expect(
        resolveCanonicalRunRuntimeWorkspace({ config: missingConfig, workspaceDir: executionRoot }),
      ).toBeUndefined();
    },
  );

  it("selects the agent's canonical workspace only for runs that execute elsewhere", () => {
    expect(
      resolveCanonicalRunRuntimeWorkspace({ config, agentId: "main", workspaceDir: executionRoot }),
    ).toMatchObject({ workspaceDir: canonical, isCanonicalWorkspace: true, usedFallback: false });
    expect(
      resolveCanonicalRunRuntimeWorkspace({ config, agentId: "main", workspaceDir: canonical }),
    ).toBeUndefined();
  });
});

describe("resolveRunWorkspaceDir", () => {
  it("resolves explicit workspace values without fallback", () => {
    const explicit = workspace("run-explicit");
    expect(
      resolve({
        workspaceDir: explicit,
        sessionKey: "agent:main:subagent:test",
      }),
    ).toMatchObject({
      usedFallback: false,
      isCanonicalWorkspace: false,
      agentId: "main",
      workspaceDir: path.resolve(explicit),
    });
  });

  it("falls back to configured per-agent workspace when input is missing", () => {
    expect(
      resolve({
        sessionKey: "agent:research:subagent:test",
      }),
    ).toMatchObject({
      usedFallback: true,
      isCanonicalWorkspace: true,
      fallbackReason: "missing",
      agentId: "research",
      workspaceDir: path.resolve(researchWorkspace),
    });
  });

  it("falls back to default workspace for blank strings", () => {
    expect(
      resolve({
        workspaceDir: "   ",
        sessionKey: "agent:main:subagent:test",
      }),
    ).toMatchObject({
      usedFallback: true,
      fallbackReason: "blank",
      agentId: "main",
      workspaceDir: path.resolve(defaultWorkspace),
    });
  });

  it("refuses to invent an agent when config is unavailable", () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
    expect(() =>
      resolve({
        workspaceDir: null,
        sessionKey: "custom-main-key",
        config: undefined,
        env: { ...process.env, OPENCLAW_WORKSPACE_DIR: workspaceDir },
      }),
    ).toThrow(expect.objectContaining({ code: "RUN_WORKSPACE_ROSTER_REQUIRED" }));
  });

  it("rejects an explicit agent when the supplied config has no roster", () => {
    expect(() =>
      resolve({
        agentId: "research",
        config: {},
      }),
    ).toThrow(expect.objectContaining({ code: "RUN_WORKSPACE_ROSTER_REQUIRED" }));
  });

  it.each(["", "!!!"])("rejects invalid explicit agent id %j", (agentId) => {
    expect(() =>
      resolve({
        workspaceDir: workspace("main"),
        agentId,
        sessionKey: "agent:main:main",
      }),
    ).toThrow("Invalid explicit agent id");
  });

  it("normalizes a valid explicit agent at the selection boundary", () => {
    const workspaceDir = workspace("ops");
    expect(
      resolve({
        agentId: " OPS ",
        sessionKey: "agent:ops:main",
        config: { agents: { entries: { ops: { workspace: workspaceDir } } } },
      }),
    ).toMatchObject({
      agentId: "ops",
      agentIdSource: "explicit",
      workspaceDir: path.resolve(workspaceDir),
    });
  });

  it.each([
    { agentId: "research", sessionKey: undefined },
    { agentId: undefined, sessionKey: "agent:research:subagent:test" },
  ])("rejects an unconfigured workspace owner for $sessionKey", ({ agentId, sessionKey }) => {
    expect(() =>
      resolve({
        agentId,
        sessionKey,
        config: { agents: { entries: { ops: {} } } },
      }),
    ).toThrow(expect.objectContaining({ code: "RUN_WORKSPACE_AGENT_NOT_CONFIGURED" }));
  });

  it("throws for malformed agent session keys even with an explicit agent owner", () => {
    // Explicit ownership must not mask malformed keys as legacy main-session keys.
    expect(() =>
      resolve({
        sessionKey: "agent::broken",
        agentId: "research",
      }),
    ).toThrow("Malformed agent session key");
  });

  it("treats non-agent legacy keys as default, not malformed", () => {
    expect(
      resolve({
        sessionKey: "custom-main-key",
      }),
    ).toMatchObject({
      agentId: "main",
      agentIdSource: "default",
      workspaceDir: path.resolve(defaultWorkspace),
    });
  });

  it("uses the persisted fixed-store owner for a bare global workspace", () => {
    const opsWorkspace = workspace("ops-global");
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: {
          ops: { workspace: opsWorkspace },
          research: { workspace: workspace("research-global") },
        },
      },
      session: { scope: "global", store: "/tmp/openclaw-shared-sessions.sqlite" },
    } satisfies OpenClawConfig;

    expect(
      resolve({
        sessionKey: "global",
        config: cfg,
      }),
    ).toMatchObject({ agentId: "ops", workspaceDir: path.resolve(opsWorkspace) });
  });
});
