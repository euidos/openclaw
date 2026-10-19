import { afterEach, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadCombinedSessionStoreForGatewayCore } from "../config/sessions/combined-store-gateway.native.js";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import type { Lookup, SnapshotOptions } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { createTestProjection } from "./session-row-projection.read-fixture.test-support.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";

afterEach(() => memorySessionActorOwners.reset());

function findKeys(
  projection: SessionRowProjection,
  query: Parameters<SessionRowProjection["findBySessionId"]>[0],
) {
  return projection.findBySessionId(query).map((row) => row.key);
}

function privateRow(
  name: string,
  overrides: Partial<InternalSessionEntry> = {},
  agentId = "main",
  storePath?: string,
) {
  const key = `agent:${agentId}:dashboard:incognito-${name}`;
  const target = { agentId, sessionKey: key, storePath };
  const entry = { sessionId: `private-${name}`, updatedAt: 1, incognito: true, ...overrides };
  return {
    key,
    target,
    entry,
    query: { agentId, key, storePath },
    write: (patch: Partial<InternalSessionEntry> = {}) =>
      replaceSessionEntry(target, { ...entry, ...patch }),
  };
}

function presentExact(projection: SessionRowProjection, query: Lookup, options?: SnapshotOptions) {
  return projection.withPreparedExactRows(
    () => [query],
    (read) => read.present(read.describe(query)!, options),
  );
}

it("finds retained incognito sessions from an explicit root distinct from the ambient root", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: state.path("previous-root") },
    });
    const privateSession = privateRow(
      "retained-root",
      { sessionId: "private-original" },
      "main",
      storePath,
    );
    const { key, target } = privateSession;
    await privateSession.write();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const query = { agentId: "main", sessionId: "private-original", federated: true };
    expect(projection.findBySessionId(query)).toMatchObject([
      { key, storeTarget: { storePath }, entry: { sessionId: "private-original" } },
    ]);
    expect(projection.findBySessionId({ ...target, sessionId: "private-original" })).toMatchObject([
      { key, entry: { sessionId: "private-original" } },
    ]);
    await privateSession.write({ sessionId: "private-current", updatedAt: 2 });
    expect(projection.findBySessionId(query)).toEqual([]);
    expect(projection.findBySessionId({ ...query, sessionId: "private-current" })).toMatchObject([
      { key, storeTarget: { storePath }, entry: { sessionId: "private-current" } },
    ]);
  });
});

it("reads a private parent once despite multiple durable store candidates", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = {
      agents: { entries: { main: {}, work: {} }, defaults: { sessionStore: { agentId: "main" } } },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const storePath of [undefined, state.statePath("extra.sqlite")]) {
      replaceSessionEntrySync(
        {
          agentId: "main",
          storePath,
          sessionKey: storePath ? "agent:main:extra" : "agent:main:main",
        },
        { sessionId: storePath ? "extra" : "durable-main", updatedAt: 1 },
      );
    }
    const parentRow = privateRow("parent", {
      providerOverride: "ollama",
      modelOverride: "qwen3:14b",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    const parent = parentRow.key;
    const child = privateRow("child", { updatedAt: 2, parentSessionKey: parent }, "work");
    const { key } = child;
    await parentRow.write();
    await child.write();
    const selected = await resolveGatewaySessionStoreTargetWithStoreAsync({
      cfg,
      key,
      agentId: "work",
      exactRead: true,
      includeStoreChildEntries: true,
    });
    expect(selected.store[parent]).toBeUndefined();
    const scoped = loadCombinedSessionStoreForGatewayCore(cfg, {
      agentId: "work",
      includeIncognito: true,
    });
    expect(scoped.targetsBySessionKey.get(key)?.readSourceEntry(parent)?.modelOverride).toBe(
      "qwen3:14b",
    );
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const query = { agentId: "work", key };
    expect(await presentExact(projection, query)).toMatchObject({
      key,
      parentSessionKey: parent,
      model: "qwen3:14b",
      modelOverrideSource: "inherited",
    });
    expect(projection.selectEntries().map((row) => row.key)).not.toContain(key);
  });
});

it.each(["capture", "prepared"] as const)(
  "reads %s incognito rows after turn-handle release and retires them on session close",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const privateSession = privateRow("released-turn", { sessionId: "private-released" });
      const { key, query } = privateSession;
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
      await privateSession.write();
      const owner = memorySessionActorOwners.read({ agentId: "main", path: storePath })!;
      const actor = (await owner.acquireExisting(key, {
        assertCurrent() {},
        assertReadable() {},
      }))!;
      const binding = {
        actor,
        agentId: "main",
        path: storePath,
        authority: { assertCurrent() {}, authorize() {} },
      };
      const projection = await createTestProjection({ cfg, modelCatalog: [] });
      const capture = () => runWithSessionActorStorage(binding, () => projection.capture(query));
      try {
        await actor.release();
        if (mode === "prepared") {
          await runWithSessionActorStorage(binding, () =>
            projection.withPreparedExactRows(
              () => [query],
              (read) => {
                expect(read.describe(query)?.entry?.sessionId).toBe("private-released");
              },
            ),
          );
        }
        const row = capture();
        expect(row?.entry?.sessionId).toBe("private-released");
        expect(projection.isCurrent(row!)).toBe(true);
        owner.closeSession(key);
        expect(projection.isCurrent(row!)).toBe(false);
        expect(capture()).toBeUndefined();
      } finally {
        await actor.release();
        projection.dispose();
      }
    });
  },
);

it("keeps archived incognito rows private and retires captures when their session or owner closes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    const privateSession = privateRow(
      "generation",
      {
        sessionId: "ephemeral-id",
        lifecycleRevision: "original",
        archivedAt: 1,
      },
      "main",
      storePath,
    );
    const { key, entry, query, target } = privateSession;
    await privateSession.write();
    await persistSessionTranscriptTurn(
      { ...target, sessionId: entry.sessionId },
      {
        messages: [
          { message: { role: "user", content: "Private conversation title" } },
          { message: { role: "assistant", content: "Private response" } },
        ],
        touchSessionEntry: false,
      },
    );
    const viewer = identifiedClient("incognito-observer");
    const projection = await createTestProjection({ cfg, getModelCatalog: async () => [] });
    try {
      const original = projection.capture(query)!;
      expect(original?.entry?.sessionId).toBe(entry.sessionId);
      expect(projection.isCurrent(original)).toBe(true);
      registerAgentRunContext("incognito-live-model", {
        agentId: "main",
        sessionKey: key,
        sessionId: entry.sessionId,
        activeModel: { provider: "row-fixture", model: "active" },
      });
      expect(
        await presentExact(projection, query, {
          includeDerivedTitles: true,
          includeLastMessage: true,
        }),
      ).toMatchObject({
        activeModelProvider: "row-fixture",
        activeModel: "active",
        derivedTitle: "Private conversation title",
        lastMessagePreview: "Private response",
      });
      expect(
        projection.capture({ ...query, storePath: "/configured/sessions.json" })?.entry,
      ).toEqual(original.entry);
      expect(projection.selectEntries()).toEqual([]);
      sessionChanges.emit({ all: true, scope: "catalog" });
      await projection.ensureMaterialized();
      expect(projection.selectEntries()).toEqual([]);
      await projection.withPreparedExactRows(
        () => [query],
        (read) => {
          const presentation = prepareProjectedSessionPresentation(read, viewer);
          expect(presentation.authorizeDescription(query)?.message).toContain("not found");
          expect(
            canReceiveSessionEvent({
              cfg,
              client: viewer,
              sessionKeys: [key],
              agentId: "main",
              event: "session.message",
              payload: { sessionKey: key },
              prepared: { sharing: presentation.sharing, target: () => presentation.target(query) },
            }),
          ).toBe(false);
        },
      );
      const identity = { agentId: "main", sessionId: entry.sessionId };
      expect(findKeys(projection, { ...identity, storePath })).toEqual([key]);
      expect(findKeys(projection, { ...identity, federated: true })).toEqual([key]);
      expect(projection.selectEntries()).toEqual([]);
      const internal = resolveInternalSessionEffectsIdentity({
        agentId: "main",
        incognito: true,
        runId: "private-maintenance",
      });
      const internalScope = { agentId: "main", storePath, ...internal };
      await replaceSessionEntry(internalScope, { ...entry, sessionId: internal.sessionId });
      await persistSessionTranscriptTurn(internalScope, {
        messages: [{ message: { role: "assistant", content: "Internal maintenance" } }],
        touchSessionEntry: false,
      });
      // Exact internal readers may address their private row; discovery must not.
      expect(findKeys(projection, internalScope)).toEqual([internal.sessionKey]);
      expect(
        projection.findBySessionId({
          agentId: "main",
          sessionId: internal.sessionId,
          federated: true,
        }),
      ).toEqual([]);
      memorySessionActorOwners.closeSession({ agentId: "main", path: storePath }, key);
      await privateSession.write();
      await projection.ensureMaterialized();
      expect(projection.isCurrent(original)).toBe(false);
      const reset = projection.capture(query)!;
      expect(projection.isCurrent(reset)).toBe(true);
      memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
      expect(projection.capture(query)).toBeUndefined();
      await privateSession.write();
      await projection.ensureMaterialized();
      expect(projection.isCurrent(reset)).toBe(false);
      expect(await presentExact(projection, query)).toMatchObject({
        key,
        sessionId: entry.sessionId,
      });
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      clearAgentRunContext("incognito-live-model");
      projection.dispose();
    }
  });
});
