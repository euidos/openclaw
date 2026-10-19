import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  createSessionMcpRuntimeManager,
  makeRuntime,
} from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
} from "./agent-bundle-mcp-types.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";

const params = {
  sessionId: "static-session",
  sessionKey: "agent:test:static-session",
  agentId: "test",
  workspaceDir: "/workspace",
  agentDir: "/agents/test",
  cfg: { mcp: { servers: { fixture: { command: "true" } } } },
  manifestRegistry: { plugins: [] },
};
const managers: ReturnType<typeof createSessionMcpRuntimeManager>[] = [];
const held: SessionMcpRuntimeLease[] = [];

function setup() {
  const sources = new Map<
    SessionMcpRuntime,
    {
      catalog: McpToolCatalog;
      pending?: Promise<McpToolCatalog>;
    }
  >();
  const factory = vi.fn<CreateSessionMcpRuntime>(async (input) => {
    const serverName = input.requesterScope ? "scoped" : "fixture";
    const runtime = makeRuntime([{ toolName: "echo", description: "Echo a value" }], serverName);
    const source: { catalog: McpToolCatalog; pending?: Promise<McpToolCatalog> } = {
      catalog: await runtime.getCatalog(),
    };
    sources.set(runtime, source);
    let activeLeases = 0;
    Object.defineProperty(runtime, "activeLeases", { get: () => activeLeases });
    return Object.assign(runtime, {
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
      workspaceDir: input.workspaceDir,
      agentDir: input.agentDir,
      configFingerprint: input.configFingerprint ?? "fixture",
      requesterScope: input.requesterScope,
      acquireLease() {
        activeLeases++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            activeLeases--;
          }
        };
      },
      getCatalog: () => source.pending ?? Promise.resolve(source.catalog),
      peekCatalog: () => null,
      callTool: vi.fn(async () => ({ content: [{ type: "text" as const, text: "live echo" }] })),
      dispose: vi.fn(async () => {}),
    });
  });
  const manager = createSessionMcpRuntimeManager({ createRuntime: factory });
  managers.push(manager);
  const fill = async (count = 256) => {
    for (let index = 0; index < count; index++) {
      held.push(
        await manager.acquire({ ...params, sessionId: `busy-${index}`, sessionKey: undefined }),
      );
    }
  };
  return { manager, factory, sources, fill };
}

async function withRequester(run: () => Promise<void>) {
  const registry = createMcpProofPluginRegistry();
  return withPluginRuntimeRegistryScope(registry.registry, async () => {
    registry.apiFor("test-plugin").registerMcpServerConnectionResolver({
      serverName: "scoped",
      resolve: async () => ({ url: "https://mcp.example.test/scoped" }),
    });
    await run();
  });
}

const mixedParams = {
  ...params,
  requesterSenderId: "alice",
  cfg: {
    mcp: {
      servers: {
        fixture: { command: "true" },
        scoped: { transport: "streamable-http" as const },
      },
    },
  },
};

afterEach(async () => {
  for (const lease of held.splice(0)) {
    lease.releaseLease();
  }
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
});

describe("MCP capacity catalog continuity", () => {
  it("keeps advertised static schemas after eviction even when the current peek is invalidated", async () => {
    const { manager, fill, factory } = setup();
    const firstLease = await manager.acquire(params);
    const first = await materializeBundleMcpToolsForRun(firstLease);
    const surface = first.tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    await first.dispose();
    await fill();
    expect(manager.peekSession({ sessionId: params.sessionId })).toBeUndefined();
    const refused = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(
      refused.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
    ).toEqual(surface);
    const result = await refused.tools[0]!.execute("capacity-call", {});
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("This turn will continue without MCP tools") },
    ]);
    expect(firstLease.runtime.callTool).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(257);
    await refused.dispose();
    held[0]!.releaseLease();
    const recovered = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect((await recovered.tools[0]!.execute("recovered-call", {})).content).toEqual([
      { type: "text", text: "live echo" },
    ]);
    await recovered.dispose();
  });

  it("preserves acquired static tools when requester admission is refused", async () => {
    await withRequester(async () => {
      const { manager, fill } = setup();
      await fill(255);
      const acquired = await manager.acquire(mixedParams);
      const tools = await materializeBundleMcpToolsForRun(acquired);
      expect(tools.tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
      expect((await tools.tools[0]!.execute("static-call", {})).content).toEqual([
        { type: "text", text: "live echo" },
      ]);
      expect(manager.peekSession({ sessionId: params.sessionId })!.activeLeases).toBe(1);
      expect(tools.diagnostics?.[0]?.message).toContain(
        "This turn will continue without MCP tools",
      );
      await tools.dispose();
      expect(manager.peekSession({ sessionId: params.sessionId })!.activeLeases).toBe(0);
    });
  });

  it("preserves a reusable requester partition when static admission is refused", async () => {
    await withRequester(async () => {
      const { manager, fill } = setup();
      const requester = await manager.acquireRequesterScoped(mixedParams);
      held.push(requester!);
      await fill(255);
      const tools = await materializeBundleMcpToolsForRun(await manager.acquire(mixedParams));
      expect(tools.tools.map((tool) => tool.name)).toEqual(["scoped__echo"]);
      expect((await tools.tools[0]!.execute("requester-call", {})).content).toEqual([
        { type: "text", text: "live echo" },
      ]);
      await tools.dispose();
    });
  });

  it.each([
    { sessionId: "other-session", sessionKey: "agent:test:other-session" },
    { workspaceDir: "/other-workspace" },
    { agentDir: "/agents/other" },
    { agentId: "other" },
    { cfg: { mcp: { servers: { fixture: { command: "changed" } } } } },
  ])("invalidates a static snapshot when its binding changes: %j", async (change) => {
    const { manager, fill } = setup();
    const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    await first.dispose();
    await fill();
    const refused = await materializeBundleMcpToolsForRun(
      await manager.acquire({ ...params, ...change }),
    );
    expect(refused.tools).toEqual([]);
    await refused.dispose();
  });

  it.each(["reload", "replacement"])(
    "does not republish an old catalog after %s while discovery is pending",
    async (invalidation) => {
      const { manager, sources, fill } = setup();
      const acquired = await manager.acquire(params);
      const source = sources.get(acquired.runtime)!;
      const pending = createDeferred<McpToolCatalog>();
      source.pending = pending.promise;
      const late = acquired.runtime.getCatalog();
      const nextParams =
        invalidation === "replacement"
          ? { ...params, cfg: { mcp: { servers: { fixture: { command: "replacement" } } } } }
          : params;
      if (invalidation === "reload") {
        await manager.reloadConfig({ cfg: params.cfg, manifestRegistry: params.manifestRegistry });
      } else {
        const replacement = await manager.acquire(nextParams);
        replacement.releaseLease();
      }
      pending.resolve(source.catalog);
      await late;
      acquired.releaseLease();
      await fill();
      const refused = await materializeBundleMcpToolsForRun(await manager.acquire(nextParams));
      expect(refused.tools).toEqual([]);
      await refused.dispose();
    },
  );

  it("keeps snapshot-only sessions reachable for agent cleanup and captured retirement", async () => {
    const { manager, fill } = setup();
    const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    await first.dispose();
    await fill();
    expect(manager.listSessionIdsForAgent("test")).toContain(params.sessionId);
    expect(manager.resolveSessionId(params.sessionKey)).toBe(params.sessionId);
    const retirement = manager.captureSessionRetirement({ sessionKey: params.sessionKey });
    expect(retirement).toBeDefined();
    await retirement!.retire(() => {});
    const refused = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(refused.tools).toEqual([]);
    await refused.dispose();
  });

  it("allows only the owning agent to retire an evicted static catalog", async () => {
    const { manager, fill } = setup();
    const first = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    await first.dispose();
    await fill();
    await manager.retireSessionForAgentDeletion(params.sessionId, "other", () => {});
    const retained = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(retained.tools.map((tool) => tool.name)).toEqual(["fixture__echo"]);
    await retained.dispose();
    await manager.retireSessionForAgentDeletion(params.sessionId, "test", () => {});
    const retired = await materializeBundleMcpToolsForRun(await manager.acquire(params));
    expect(retired.tools).toEqual([]);
    await retired.dispose();
  });
});
