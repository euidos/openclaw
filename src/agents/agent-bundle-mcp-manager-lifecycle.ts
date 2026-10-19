import { AsyncLocalStorage } from "node:async_hooks";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { raceWithTimeout } from "@openclaw/retry";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import type { GatewayScheduler, GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import { logWarn } from "../logger.js";
import { enqueueKeyedTask } from "../plugin-sdk/keyed-async-queue.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { compareMcpCatalogTools } from "./agent-bundle-mcp-names.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import {
  SessionMcpRuntimeCapacityError,
  SESSION_MCP_MAX_LIVE_RUNTIMES,
  SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  RequesterScopedMcpRuntimeHandle,
  SessionMcpConfigReload,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

// Gateway shutdown preparation and CLI command imports load this before turns.
// The process-owned sweep must not retain its first requesting turn.
const runInMcpManagerContext = AsyncLocalStorage.snapshot();
const CAPACITY_CLEANUP_WAIT_MS = 5_000;

export type SessionMcpConfigPublication = SessionMcpConfigReload & { pluginGeneration: number };

type AdvertisedScopedCatalogEntry = {
  configFingerprint: string;
  servers: Map<string, McpServerCatalog>;
  toolsByServer: Map<string, McpCatalogTool[]>;
  signaturesByServer: Map<string, string>;
};

type StaticCatalogBinding = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
};

type StaticCatalogEntry = StaticCatalogBinding & { catalog: McpToolCatalog | null };

type RuntimeDisposalReceipt = {
  pending: Set<Promise<void>>;
  failure?: PromiseRejectedResult;
  agentId?: string;
};

type SessionMcpRuntimeManagerStore = {
  configReload?: SessionMcpConfigPublication;
  runtimesBySessionId: Map<string, SessionMcpRuntime>;
  sessionIdBySessionKey: Map<string, string>;
  deferredRetirementSessionIds: Set<string>;
  // Reset/delete retirement survives late creation or reuse by the stopping run.
  requiredRetirementSessionIds: Set<string>;
  connectionMetaByRuntimeKey: Map<string, { connectionHash: string; resolvedAt: number }>;
  advertisedScopedCatalogBySessionId: Map<string, AdvertisedScopedCatalogEntry>;
  staticCatalogBySessionId: Map<string, StaticCatalogEntry>;
  runtimeWorkChains: Map<string, Promise<unknown>>;
  disposalInFlight?: Promise<void>;
  pendingDisposals: Map<string, RuntimeDisposalReceipt>;
  createRuntime: CreateSessionMcpRuntime;
  runtimeSlots: WeakMap<SessionMcpRuntime, { idleTtlMs: number }>;
  liveRuntimeSlots: Set<{ idleTtlMs: number }>;
  scheduler: GatewayScheduler;
  idleSweepJob: GatewayScheduledJob | undefined;
};

export type SessionMcpRuntimeManagerOpts = {
  scheduler: GatewayScheduler;
};

function parseRuntimeCacheSessionId(runtimeKey: string): string {
  const sessionId = runtimeKey.startsWith("{")
    ? safeParseJsonRecord(runtimeKey)?.sessionId
    : undefined;
  return typeof sessionId === "string" ? sessionId : runtimeKey;
}

function runtimeAgentId(runtime: SessionMcpRuntime): string | undefined {
  return (
    sessionMcpRuntimeOwners.get(runtime)?.agentId ??
    parseAgentSessionKey(runtime.sessionKey ?? "")?.agentId
  );
}

export type SessionMcpRuntimeManagerLifecycle = ReturnType<
  typeof createSessionMcpRuntimeManagerLifecycle
>;

function scopedCatalogToolsSignature(tools: readonly McpCatalogTool[]): string {
  return JSON.stringify(
    tools.map((tool) => [
      tool.serverName,
      tool.safeServerName,
      tool.toolName,
      tool.title ?? "",
      tool.description ?? "",
      tool.fallbackDescription,
      tool.inputSchema,
      tool.uiResourceUri ?? "",
      tool.uiVisibility ?? null,
    ]),
  );
}

export function createSessionMcpRuntimeManagerLifecycle(
  options: SessionMcpRuntimeManagerOpts,
  createSessionMcpRuntime: CreateSessionMcpRuntime,
) {
  const store: SessionMcpRuntimeManagerStore = {
    // Keys are bare sessionId for static runtimes, or requester composite JSON keys.
    runtimesBySessionId: new Map<string, SessionMcpRuntime>(),
    sessionIdBySessionKey: new Map<string, string>(),
    deferredRetirementSessionIds: new Set<string>(),
    requiredRetirementSessionIds: new Set<string>(),
    // Manager-side only: connection hash + resolve time. Never stores raw url/headers.
    connectionMetaByRuntimeKey: new Map(),
    /**
     * Session-stable advertised catalogs for requester-scoped servers.
     * Keyed by sessionId → serverName. Specs must not vary per sender or shared
     * Codex threads rotate (dynamicToolsFingerprint churn).
     */
    advertisedScopedCatalogBySessionId: new Map(),
    staticCatalogBySessionId: new Map(),
    /**
     * Per-runtimeKey serialization for acquisition and dispose.
     * Sections never overlap for one key, so a slow resolve cannot clobber a newer install.
     * Entries are removed when their chain drains.
     */
    runtimeWorkChains: new Map(),
    pendingDisposals: new Map(),
    createRuntime: createSessionMcpRuntime,
    runtimeSlots: new WeakMap(),
    liveRuntimeSlots: new Set(),
    scheduler: options.scheduler,
    idleSweepJob: undefined,
  };
  let schedulerScope = store.scheduler.scope();
  let capacityNoticeActive = false;
  const capacityRefusal = () => {
    const refusal = new SessionMcpRuntimeCapacityError(!capacityNoticeActive);
    if (refusal.notify) {
      logWarn(`bundle-mcp: ${refusal.message}`);
    }
    capacityNoticeActive = true;
    return refusal;
  };
  const reserveRuntimeSlot = async (
    existing: SessionMcpRuntime | undefined,
    hasServers: boolean,
  ): Promise<{ idleTtlMs: number }> => {
    const slot = (existing && store.runtimeSlots.get(existing)) ?? { idleTtlMs: 0 };
    if (!hasServers || store.liveRuntimeSlots.has(slot)) {
      return slot;
    }
    const cleanupDeadline = Date.now() + CAPACITY_CLEANUP_WAIT_MS;
    while (store.liveRuntimeSlots.size >= SESSION_MCP_MAX_LIVE_RUNTIMES) {
      const idle = [...store.runtimesBySessionId]
        .filter(([key, runtime]) => {
          const currentSlot = store.runtimeSlots.get(runtime);
          return (
            currentSlot !== undefined &&
            store.liveRuntimeSlots.has(currentSlot) &&
            isRuntimeIdle(key, runtime)
          );
        })
        .toSorted(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
      const remainingMs = cleanupDeadline - Date.now();
      if (!idle || remainingMs <= 0) {
        throw capacityRefusal();
      }
      // Unpublish before yielding; successors reconnect under their own key queue.
      // Admission bounds waiting; tracked disposal keeps its slot until physical closure.
      const settled = await raceWithTimeout(
        retireIdleRuntimes([{ runtimeKey: idle[0], runtime: idle[1] }]).then(() => true),
        remainingMs,
        () => false,
        { ref: false },
      );
      if (!settled) {
        throw capacityRefusal();
      }
    }
    capacityNoticeActive = false;
    store.liveRuntimeSlots.add(slot);
    return slot;
  };
  const releaseEmptyRuntimeSlot = async (runtimeKey: string, runtime: SessionMcpRuntime) => {
    const slot = store.runtimeSlots.get(runtime);
    if (!slot) {
      return;
    }
    if (!runtime.joinCleanup) {
      throw new Error("MCP runtime does not expose cleanup ownership");
    }
    await runtime.joinCleanup();
    const owner = sessionMcpRuntimeOwners.get(runtime);
    // Replacement transfers the slot before cleanup yields; only its current owner may release it.
    if (store.runtimesBySessionId.get(runtimeKey) === runtime && owner?.hasServers() !== true) {
      store.liveRuntimeSlots.delete(slot);
      // A drained transport releases capacity, but a retained handle still owns
      // its binding. Final handle release reaps it; sign-in capabilities stay owned.
      if (
        owner?.hasServers() === false &&
        (runtime.activeLeases ?? 0) === 0 &&
        Object.keys(runtime.requesterConnect?.catalog.servers ?? {}).length === 0
      ) {
        store.runtimesBySessionId.delete(runtimeKey);
        store.connectionMetaByRuntimeKey.delete(runtimeKey);
        store.runtimeSlots.delete(runtime);
        pruneSessionBookkeeping();
      }
    }
  };
  const disposeRuntime = async (runtime: SessionMcpRuntime, releaseSlot = true) => {
    const agentId = runtimeAgentId(runtime);
    const receipt: RuntimeDisposalReceipt = store.pendingDisposals.get(runtime.sessionId) ?? {
      pending: new Set(),
    };
    receipt.agentId ??= agentId;
    store.pendingDisposals.set(runtime.sessionId, receipt);
    try {
      await runtime.dispose();
      if (!runtime.joinCleanup) {
        throw new Error("MCP runtime does not expose cleanup ownership");
      }
      await runtime.joinCleanup();
      const slot = store.runtimeSlots.get(runtime);
      if (releaseSlot && slot) {
        store.liveRuntimeSlots.delete(slot);
        store.runtimeSlots.delete(runtime);
      }
    } catch (error) {
      // A later deletion must observe failed closure even after this caller settles.
      receipt.failure ??= { status: "rejected", reason: error };
      recordAgentCleanupFailure();
      throw error;
    } finally {
      if (receipt.pending.size === 0 && !receipt.failure) {
        store.pendingDisposals.delete(runtime.sessionId);
      }
    }
  };
  const trackDisposal = (runtimeKeys: string[], close: () => Promise<void>): Promise<void> => {
    const disposal = Promise.resolve()
      .then(close)
      .catch((error: unknown) => {
        recordAgentCleanupFailure();
        throw error;
      })
      .finally(() => {
        for (const runtimeKey of runtimeKeys) {
          const pending = store.pendingDisposals.get(runtimeKey);
          pending?.pending.delete(disposal);
          if (pending?.pending.size === 0 && !pending.failure) {
            store.pendingDisposals.delete(runtimeKey);
          }
        }
        // A pending close can outlive the last empty runtime or queued acquisition.
        pruneSessionBookkeeping();
      });
    for (const runtimeKey of runtimeKeys) {
      const pending = store.pendingDisposals.get(runtimeKey) ?? { pending: new Set() };
      store.pendingDisposals.set(runtimeKey, pending);
      pending.pending.add(disposal);
    }
    return disposal;
  };
  const pruneSessionBookkeeping = () => {
    const ownedSessionIds = new Set([
      ...[...store.runtimesBySessionId.values()].map((runtime) => runtime.sessionId),
      ...[...store.runtimeWorkChains.keys(), ...store.pendingDisposals.keys()].map(
        parseRuntimeCacheSessionId,
      ),
    ]);
    for (const runId of listLiveAgentRunIds()) {
      if (hasAgentRunContextExecutionOwner(runId)) {
        const run = getAgentRunContext(runId);
        const sessionId = run?.sessionId ?? store.sessionIdBySessionKey.get(run?.sessionKey ?? "");
        if (sessionId) {
          ownedSessionIds.add(sessionId);
        }
      }
    }
    // Map order tracks last acquisition, including refused reuse. Live owners are
    // exempt; keep only one runtime-cap's worth of evicted session snapshots.
    const evicted: string[] = [];
    for (const [sessionId, entry] of store.staticCatalogBySessionId) {
      if (!ownedSessionIds.has(sessionId)) {
        if (entry.catalog) {
          evicted.push(sessionId);
        } else {
          store.staticCatalogBySessionId.delete(sessionId);
        }
      }
    }
    for (const sessionId of evicted.slice(0, -SESSION_MCP_MAX_LIVE_RUNTIMES)) {
      store.staticCatalogBySessionId.delete(sessionId);
    }
    for (const [sessionKey, sessionId] of store.sessionIdBySessionKey) {
      if (!ownedSessionIds.has(sessionId) && !store.staticCatalogBySessionId.has(sessionId)) {
        store.sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const runtimeKeysForSessionId = (sessionId: string): string[] => {
    const keys = new Set<string>();
    for (const [runtimeKey, runtime] of store.runtimesBySessionId.entries()) {
      if (runtime.sessionId === sessionId) {
        keys.add(runtimeKey);
      }
    }
    for (const runtimeKey of [
      ...store.runtimeWorkChains.keys(),
      ...store.pendingDisposals.keys(),
    ]) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        keys.add(runtimeKey);
      }
    }
    return [...keys];
  };

  const totalActiveLeasesForSessionId = (sessionId: string): number => {
    let total = 0;
    for (const runtimeKey of runtimeKeysForSessionId(sessionId)) {
      total += store.runtimesBySessionId.get(runtimeKey)?.activeLeases ?? 0;
    }
    return total;
  };

  const runExclusiveOnRuntimeKeys = <T>(
    runtimeKeys: string[],
    work: () => Promise<T>,
  ): Promise<T> => {
    const run = enqueueKeyedTask({
      tails: store.runtimeWorkChains,
      keys: runtimeKeys,
      task: work,
    });
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    void settled.finally(() => {
      // A full admission may install a requester after discarding its empty static partition.
      pruneSessionBookkeeping();
    });
    return run;
  };

  const isRuntimeIdle = (runtimeKey: string, runtime: SessionMcpRuntime): boolean =>
    (runtime.activeLeases ?? 0) === 0 &&
    !store.runtimeWorkChains.has(runtimeKey) &&
    !listLiveAgentRunIds().some((runId) => {
      const run = getAgentRunContext(runId);
      return (
        hasAgentRunContextExecutionOwner(runId) &&
        (run?.sessionId === runtime.sessionId ||
          (!run?.sessionId &&
            runtime.sessionKey !== undefined &&
            run?.sessionKey === runtime.sessionKey))
      );
    });

  const retireIdleRuntimes = async (
    expired: Array<{ runtimeKey: string; runtime: SessionMcpRuntime }>,
  ): Promise<void> => {
    for (const { runtimeKey } of expired) {
      store.runtimesBySessionId.delete(runtimeKey);
      store.connectionMetaByRuntimeKey.delete(runtimeKey);
    }
    const touchedSessionIds = new Set(expired.map(({ runtime }) => runtime.sessionId));
    for (const sessionId of touchedSessionIds) {
      if (runtimeKeysForSessionId(sessionId).length === 0) {
        store.deferredRetirementSessionIds.delete(sessionId);
      }
    }
    await Promise.allSettled(
      expired.map(({ runtimeKey, runtime }) => {
        // Reserve the evicted key through physical cleanup, even if admission
        // stops waiting. Reacquisition must not overlap the original process.
        const closing = runExclusiveOnRuntimeKeys([runtimeKey], () => disposeRuntime(runtime));
        return trackDisposal([runtimeKey], () => closing);
      }),
    );
    ensureIdleSweepTimer();
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = store.scheduler.now();
    const expired = [...store.runtimesBySessionId].flatMap(([runtimeKey, runtime]) => {
      const idleTtlMs = store.runtimeSlots.get(runtime)?.idleTtlMs ?? 0;
      return idleTtlMs > 0 &&
        nowMs - runtime.lastUsedAt >= idleTtlMs &&
        isRuntimeIdle(runtimeKey, runtime)
        ? [{ runtimeKey, runtime }]
        : [];
    });
    await retireIdleRuntimes(expired);
    return expired.length;
  };

  const ensureIdleSweepTimer = () => {
    const enabled = [...store.runtimesBySessionId.values()].some(
      (runtime) => (store.runtimeSlots.get(runtime)?.idleTtlMs ?? 0) > 0,
    );
    if (!enabled) {
      clearIdleSweepTimer();
      return;
    }
    if (store.idleSweepJob || schedulerScope.signal.aborted) {
      return;
    }
    store.idleSweepJob = runInMcpManagerContext(() =>
      schedulerScope.schedule({
        id: "mcp:idle-runtimes",
        atMs: store.scheduler.now() + SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
        everyMs: SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS,
        run: () =>
          sweepIdleRuntimes().catch((error: unknown) => {
            logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
          }),
      }),
    );
  };

  const clearIdleSweepTimer = () => {
    store.idleSweepJob?.cancel();
    store.idleSweepJob = undefined;
  };

  const setScheduler = async (scheduler: GatewayScheduler): Promise<void> => {
    scheduler.signal.throwIfAborted();
    if (scheduler === store.scheduler) {
      return;
    }
    const previous = schedulerScope;
    previous.beginClose();
    store.scheduler = scheduler;
    await previous.stop();
    store.idleSweepJob = undefined;
    schedulerScope = scheduler.scope();
    ensureIdleSweepTimer();
  };

  const disposeRuntimeKeyNow = async (runtimeKey: string): Promise<void> => {
    const runtime = store.runtimesBySessionId.get(runtimeKey);
    store.runtimesBySessionId.delete(runtimeKey);
    store.connectionMetaByRuntimeKey.delete(runtimeKey);
    if (runtime) {
      await disposeRuntime(runtime);
    }
  };

  const disposeManagedRuntimes = (
    sessionId?: string,
    opts?: {
      preserveRequiredRetirement?: boolean;
      requireStoppedScheduler?: boolean;
      expectedRuntimes?: ReadonlyMap<string, SessionMcpRuntime>;
      expectedStaticCatalog?: StaticCatalogEntry;
      preserveActiveLeases?: boolean;
      assertCurrent?: () => void;
      agentDeletion?: {
        agentId: string;
        assertCurrent: () => void;
        deferRetirement: () => void;
      };
    },
  ): Promise<void> => {
    const runtimeKeys = [
      ...new Set(
        sessionId === undefined
          ? [
              ...store.runtimesBySessionId.keys(),
              ...store.runtimeWorkChains.keys(),
              ...store.pendingDisposals.keys(),
            ]
          : [sessionId, ...runtimeKeysForSessionId(sessionId)],
      ),
    ];
    // Capture before queuing: the previous owner may unpublish and settle before
    // this caller enters the runtime-key chain, but its receipt still belongs here.
    const previousDisposals = new Set(
      runtimeKeys.flatMap((key) => [...(store.pendingDisposals.get(key)?.pending ?? [])]),
    );
    const priorDisposal = store.disposalInFlight;
    const queued = runExclusiveOnRuntimeKeys(runtimeKeys, async () => {
      await priorDisposal;
      opts?.assertCurrent?.();
      const expectedRuntimes = opts?.expectedRuntimes;
      if (
        opts?.expectedStaticCatalog &&
        (sessionId === undefined ||
          store.staticCatalogBySessionId.get(sessionId) !== opts.expectedStaticCatalog)
      ) {
        return;
      }
      if (
        expectedRuntimes &&
        ([...expectedRuntimes].some(
          ([key, runtime]) => store.runtimesBySessionId.get(key) !== runtime,
        ) ||
          (sessionId !== undefined &&
            runtimeKeysForSessionId(sessionId).some((key) => {
              const current = store.runtimesBySessionId.get(key);
              return current && expectedRuntimes.get(key) !== current;
            })))
      ) {
        return;
      }
      if (
        opts?.preserveActiveLeases &&
        sessionId !== undefined &&
        totalActiveLeasesForSessionId(sessionId) > 0
      ) {
        store.deferredRetirementSessionIds.add(sessionId);
        return;
      }
      const deletion = opts?.agentDeletion;
      if (deletion) {
        deletion.assertCurrent();
        const staticCatalog = store.staticCatalogBySessionId.get(sessionId ?? "");
        if (staticCatalog && staticCatalog.agentId !== deletion.agentId) {
          return;
        }
        const failed = store.pendingDisposals.get(sessionId ?? "");
        if (failed?.failure && failed.agentId === deletion.agentId) {
          throw failed.failure.reason;
        }
        // A captured session id can be rebound while earlier acquisition finishes.
        if (
          runtimeKeys.some((key) => {
            const runtime = store.runtimesBySessionId.get(key);
            return runtime && runtimeAgentId(runtime) !== deletion.agentId;
          })
        ) {
          return;
        }
        if (sessionId !== undefined && totalActiveLeasesForSessionId(sessionId) > 0) {
          deletion.deferRetirement();
          throw new Error(
            `Session ${sessionId} still has active MCP leases; close its views and retry deletion`,
          );
        }
      }
      if (
        opts?.requireStoppedScheduler &&
        (!store.scheduler.signal.aborted ||
          (sessionId !== undefined && totalActiveLeasesForSessionId(sessionId) > 0))
      ) {
        return;
      }
      // Clear bookkeeping after admitted acquisitions finish, before successors run.
      if (sessionId === undefined) {
        clearIdleSweepTimer();
        store.configReload = undefined;
        store.sessionIdBySessionKey.clear();
        store.deferredRetirementSessionIds.clear();
        store.requiredRetirementSessionIds.clear();
        store.advertisedScopedCatalogBySessionId.clear();
        store.staticCatalogBySessionId.clear();
      } else {
        store.deferredRetirementSessionIds.delete(sessionId);
        if (opts?.preserveRequiredRetirement !== true) {
          store.requiredRetirementSessionIds.delete(sessionId);
        }
        store.advertisedScopedCatalogBySessionId.delete(sessionId);
        store.staticCatalogBySessionId.delete(sessionId);
      }
      const outcomes = await Promise.allSettled([
        ...previousDisposals,
        ...runtimeKeys.map(async (runtimeKey) => {
          deletion?.assertCurrent();
          opts?.assertCurrent?.();
          const runtime = store.runtimesBySessionId.get(runtimeKey);
          if (deletion && runtime && runtimeAgentId(runtime) !== deletion.agentId) {
            return;
          }
          await disposeRuntimeKeyNow(runtimeKey);
        }),
      ]);
      const failed =
        outcomes.find((outcome) => outcome.status === "rejected") ??
        runtimeKeys
          .map((key) => store.pendingDisposals.get(key))
          .find(
            (receipt) =>
              receipt?.failure &&
              (!deletion || !receipt.agentId || receipt.agentId === deletion.agentId),
          )?.failure;
      ensureIdleSweepTimer();
      if (failed) {
        throw failed.reason;
      }
    });
    const disposal = trackDisposal(runtimeKeys, () => queued).catch((error: unknown) => {
      if (opts?.agentDeletion || opts?.assertCurrent) {
        throw error;
      }
    });
    if (sessionId === undefined) {
      // New session keys also wait for a global teardown already in progress.
      store.disposalInFlight = disposal;
    }
    return disposal.finally(() => {
      if (store.disposalInFlight === disposal) {
        store.disposalInFlight = undefined;
      }
    });
  };

  const reconcileStaticCatalog = (binding: StaticCatalogBinding): void => {
    const current = store.staticCatalogBySessionId.get(binding.sessionId);
    if (
      current &&
      (current.configFingerprint !== binding.configFingerprint ||
        current.workspaceDir !== binding.workspaceDir ||
        current.agentDir !== binding.agentDir ||
        current.agentId !== binding.agentId ||
        current.sessionKey !== binding.sessionKey)
    ) {
      store.staticCatalogBySessionId.delete(binding.sessionId);
    } else if (current) {
      store.staticCatalogBySessionId.delete(binding.sessionId);
      store.staticCatalogBySessionId.set(binding.sessionId, current);
    }
  };

  const observedStaticRuntimes = new WeakSet<SessionMcpRuntime>();
  const observeStaticCatalog = (runtime: SessionMcpRuntime, binding: StaticCatalogBinding) => {
    reconcileStaticCatalog(binding);
    if (!store.staticCatalogBySessionId.has(binding.sessionId)) {
      store.staticCatalogBySessionId.set(binding.sessionId, { ...binding, catalog: null });
    }
    if (observedStaticRuntimes.has(runtime)) {
      return;
    }
    observedStaticRuntimes.add(runtime);
    const getCatalog = runtime.getCatalog.bind(runtime);
    runtime.getCatalog = async () => {
      const publication = store.staticCatalogBySessionId.get(runtime.sessionId);
      const catalog = await getCatalog();
      // Retain schemas across eviction, never late results from a replaced/reset owner.
      if (
        publication &&
        store.staticCatalogBySessionId.get(runtime.sessionId) === publication &&
        store.runtimesBySessionId.get(runtime.sessionId) === runtime &&
        sessionMcpRuntimeOwners.get(runtime)?.isCurrent() !== false
      ) {
        publication.catalog = catalog;
      }
      return catalog;
    };
  };

  const rememberAdvertisedScopedCatalog = (
    handle: RequesterScopedMcpRuntimeHandle,
    catalog: McpToolCatalog,
  ): void => {
    const { runtime, advertisedCatalogConfigFingerprint } = handle;
    // Config reconciliation replaces the cache; publish only for its matching config.
    const entry = store.advertisedScopedCatalogBySessionId.get(runtime.sessionId);
    if (entry?.configFingerprint !== advertisedCatalogConfigFingerprint) {
      return;
    }
    const toolsByServerName = new Map<string, McpCatalogTool[]>();
    for (const tool of catalog.tools) {
      const list = toolsByServerName.get(tool.serverName) ?? [];
      list.push(tool);
      toolsByServerName.set(tool.serverName, list);
    }
    for (const [serverName, server] of Object.entries(catalog.servers)) {
      const tools = (toolsByServerName.get(serverName) ?? []).toSorted((a, b) =>
        a.toolName.localeCompare(b.toolName),
      );
      const signature = scopedCatalogToolsSignature(tools);
      // Identity compare: overwrite only when the listed tool surface changes.
      if (entry.signaturesByServer.get(serverName) === signature) {
        continue;
      }
      entry.servers.set(serverName, server);
      entry.toolsByServer.set(serverName, tools);
      entry.signaturesByServer.set(serverName, signature);
    }
  };

  const getAdvertisedScopedCatalog = (sessionId: string): McpToolCatalog | null => {
    const entry = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry || entry.servers.size === 0) {
      return null;
    }
    const servers: Record<string, McpServerCatalog> = {};
    const tools: McpCatalogTool[] = [];
    for (const serverName of [...entry.servers.keys()].toSorted((a, b) => a.localeCompare(b))) {
      servers[serverName] = entry.servers.get(serverName)!;
      tools.push(...(entry.toolsByServer.get(serverName) ?? []));
    }
    tools.sort(compareMcpCatalogTools);
    return {
      version: 1,
      generatedAt: store.scheduler.now(),
      servers,
      tools,
    };
  };

  const reconcileAdvertisedScopedCatalogConfig = (
    sessionId: string,
    fingerprint: string,
    preparePublication: boolean,
  ): void => {
    const current = store.advertisedScopedCatalogBySessionId.get(sessionId);
    if (current?.configFingerprint === fingerprint || (!current && !preparePublication)) {
      return;
    }
    store.advertisedScopedCatalogBySessionId.set(sessionId, {
      configFingerprint: fingerprint,
      servers: new Map(),
      toolsByServer: new Map(),
      signaturesByServer: new Map(),
    });
  };

  return {
    store,
    runtimeKeysForSessionId,
    pruneSessionBookkeeping,
    totalActiveLeasesForSessionId,
    runExclusiveOnRuntimeKeys,
    sweepIdleRuntimes,
    setScheduler,
    reserveRuntimeSlot,
    releaseEmptyRuntimeSlot,
    disposeRuntime,
    ensureIdleSweepTimer,
    disposeRuntimeKeyNow,
    disposeManagedRuntimes,
    reconcileStaticCatalog,
    observeStaticCatalog,
    rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog,
    reconcileAdvertisedScopedCatalogConfig,
  };
}
