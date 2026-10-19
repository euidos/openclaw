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
  const rooted = (params: Partial<Parameters<typeof resolveRootedRunRuntimeWorkspace>[0]>) =>
    resolveRootedRunRuntimeWorkspace({
      config,
      agentId: "main",
      workspaceDir: executionRoot,
      bootstrapWorkspaceDir: canonical,
      ...params,
    });
  const canonicalRun = (workspaceDir: string) =>
    resolveCanonicalRunRuntimeWorkspace({ config, agentId: "main", workspaceDir });

  it.each([
    { bootstrapWorkspaceDir: canonical, expected: canonical },
    { bootstrapWorkspaceDir: executionRoot, expected: undefined },
    { bootstrapWorkspaceDir: undefined, expected: undefined },
  ])(
    "only borrows canonical bootstrap $bootstrapWorkspaceDir",
    ({ bootstrapWorkspaceDir, expected }) => {
      expect(rooted({ bootstrapWorkspaceDir })?.workspaceDir).toBe(expected);
    },
  );

  it.each([false, true])(
    "keeps same-workspace reload binding unless execution is confined (%s)",
    (confined) => {
      expect(
        rooted({
          workspaceDir: canonical,
          ...(confined ? { requireWorkspaceOnly: true, sessionRoot: canonical } : {}),
        })?.workspaceDir,
      ).toBe(confined ? canonical : undefined);
    },
  );

  it.each([undefined, {}])(
    "does not invent canonical ownership without a roster (%j)",
    (missingConfig) => {
      expect(rooted({ config: missingConfig })).toBeUndefined();
      expect(
        resolveCanonicalRunRuntimeWorkspace({ config: missingConfig, workspaceDir: executionRoot }),
      ).toBeUndefined();
    },
  );

  it("selects the agent's canonical workspace only for runs that execute elsewhere", () => {
    expect(canonicalRun(executionRoot)).toMatchObject({
      workspaceDir: canonical,
      isCanonicalWorkspace: true,
      usedFallback: false,
    });
    expect(canonicalRun(canonical)).toBeUndefined();
  });
});

describe("resolveRunWorkspaceDir", () => {
  const explicit = workspace("run-explicit");
  const ops = workspace("ops");
  it.each([
    {
      name: "explicit workspace",
      input: { workspaceDir: explicit, sessionKey: "agent:main:subagent:test" },
      expected: {
        usedFallback: false,
        isCanonicalWorkspace: false,
        agentId: "main",
        workspaceDir: explicit,
      },
    },
    {
      name: "missing per-agent workspace",
      input: { sessionKey: "agent:research:subagent:test" },
      expected: {
        usedFallback: true,
        isCanonicalWorkspace: true,
        fallbackReason: "missing",
        agentId: "research",
        workspaceDir: researchWorkspace,
      },
    },
    {
      name: "blank default workspace",
      input: { workspaceDir: "   ", sessionKey: "agent:main:subagent:test" },
      expected: {
        usedFallback: true,
        fallbackReason: "blank",
        agentId: "main",
        workspaceDir: defaultWorkspace,
      },
    },
    {
      name: "normalized explicit owner",
      input: {
        agentId: " OPS ",
        sessionKey: "agent:ops:main",
        config: { agents: { entries: { ops: { workspace: ops } } } },
      },
      expected: { agentId: "ops", agentIdSource: "explicit", workspaceDir: ops },
    },
    {
      name: "legacy non-agent key",
      input: { sessionKey: "custom-main-key" },
      expected: { agentId: "main", agentIdSource: "default", workspaceDir: defaultWorkspace },
    },
  ])("resolves $name", ({ input, expected }) => {
    expect(resolve(input)).toMatchObject(expected);
  });

  const rosterRequired = expect.objectContaining({ code: "RUN_WORKSPACE_ROSTER_REQUIRED" });
  const notConfigured = expect.objectContaining({ code: "RUN_WORKSPACE_AGENT_NOT_CONFIGURED" });
  const invalidOwner = (agentId: string) => ({
    workspaceDir: workspace("main"),
    agentId,
    sessionKey: "agent:main:main",
  });
  const opsOnly = { agents: { entries: { ops: {} } } };
  it.each([
    {
      name: "missing config despite environment workspace",
      input: {
        workspaceDir: null,
        sessionKey: "custom-main-key",
        config: undefined,
        env: {
          ...process.env,
          OPENCLAW_WORKSPACE_DIR: path.join(path.sep, "srv", "openclaw-workspace"),
        },
      },
      error: rosterRequired,
    },
    {
      name: "explicit owner without roster",
      input: { agentId: "research", config: {} },
      error: rosterRequired,
    },
    { name: "empty owner", input: invalidOwner(""), error: "Invalid explicit agent id" },
    { name: "invalid owner", input: invalidOwner("!!!"), error: "Invalid explicit agent id" },
    {
      name: "unconfigured owner",
      input: { agentId: "research", config: opsOnly },
      error: notConfigured,
    },
    {
      name: "unconfigured session owner",
      input: { sessionKey: "agent:research:subagent:test", config: opsOnly },
      error: notConfigured,
    },
    {
      name: "malformed agent key despite explicit owner",
      input: { sessionKey: "agent::broken", agentId: "research" },
      error: "Malformed agent session key",
    },
  ])("rejects $name", ({ input, error }) => {
    expect(() => resolve(input)).toThrow(error);
  });

  it("uses persisted fixed-store ownership for a bare global workspace", () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: { workspace: ops }, research: { workspace: researchWorkspace } },
      },
      session: { scope: "global", store: "/tmp/openclaw-shared-sessions.sqlite" },
    };
    expect(resolve({ sessionKey: "global", config })).toMatchObject({
      agentId: "ops",
      workspaceDir: ops,
    });
  });
});
