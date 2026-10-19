import { afterEach, expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { cronTestJob } from "../cron/service.fixture-builders.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { registerSessionAutomationSource } from "./session-automation-index.js";
import * as membership from "./session-membership-projection.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  holdForeground,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

afterEach(() => vi.restoreAllMocks());

function installHarness(
  id: string,
  resolveSessionRuntimeOwnershipAsync?: AgentHarness["resolveSessionRuntimeOwnershipAsync"],
) {
  const previous = captureActivePluginRegistrySnapshot();
  const registry = createEmptyPluginRegistry();
  registry.agentHarnesses.push({
    pluginId: id,
    source: "test",
    harness: {
      id,
      label: "Session ownership fixture",
      supports: () => ({ supported: true }),
      ...(resolveSessionRuntimeOwnershipAsync ? { resolveSessionRuntimeOwnershipAsync } : {}),
      async runAttempt() {
        throw new Error("Session presentation must not run a model");
      },
    },
  });
  setActivePluginRegistry(registry);
  return { [Symbol.dispose]: () => restoreActivePluginRegistrySnapshot(previous) };
}

const visibleKey = "agent:main:visible",
  offPageKey = "agent:main:off-page";
it.for([
  ["off-page", {}, "response", [visibleKey]],
  ["selected", { limit: 2 }, "off-page ownership", [visibleKey, offPageKey]],
  ["search", { search: "visible" }, "off-page ownership", [visibleKey]],
  ["without Board", { hasBoard: false }, "off-page ownership", [visibleKey]],
  ["with Board", { hasBoard: true }, "off-page ownership", []],
] satisfies [string, SessionsListParams, string, string[]][])(
  "preserves %s readiness when listing a sidebar page",
  async ([, options, firstExpected, keys], { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const visible = { agentId: "main", sessionKey: visibleKey };
      const offPage = { agentId: "main", sessionKey: offPageKey };
      replaceSessionEntrySync(visible, {
        sessionId: "visible",
        updatedAt: 2,
        visibility: "shared",
      });
      const offPageEntry = {
        sessionId: "off-page",
        updatedAt: 1,
        visibility: "shared" as const,
        agentHarnessId: "sidebar-owner",
        modelSelectionLocked: true,
      };
      replaceSessionEntrySync(offPage, offPageEntry);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let holdOwnership = false;
      using _ = installHarness("sidebar-owner", async ({ assertCurrent }) => {
        if (holdOwnership) {
          entered.resolve();
          await release.promise;
        }
        assertCurrent();
        return undefined;
      });
      const abort = () => release.resolve();
      signal.addEventListener("abort", abort, { once: true });
      let projection: Awaited<ReturnType<typeof createSessionRowProjection>> | undefined;
      let reading: ReturnType<typeof listSessions> | undefined;
      try {
        projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        const context = bindSessionRowProjection(requestContext(cfg), () => projection);
        const client = identifiedClient("sidebar-viewer");
        const request: SessionsListParams = { rowMode: "sidebar", limit: 1, ...options };
        const initial = await listSessions({
          context,
          client,
          request: { rowMode: "sidebar", limit: 1 },
        });
        expect(initial.sessions.map((row) => row.key)).toEqual([visible.sessionKey]);
        const first = await projection.withSelectionPreparation(async () => {
          holdOwnership = true;
          replaceSessionEntrySync(offPage, { ...offPageEntry, label: "Renamed off-page" });
          reading = listSessions({ context, client, request, acceptsSerializedJson: true });
          const winner = await Promise.race([
            reading.then(() => "response" as const),
            entered.promise.then(() => "off-page ownership" as const),
          ]);
          release.resolve();
          const result = await reading;
          expect(result.sessions.map((row) => row.key)).toEqual(keys);
          return winner;
        });
        expect(first).toBe(firstExpected);
      } finally {
        release.resolve();
        await Promise.allSettled(reading ? [reading] : []);
        projection?.dispose();
        signal.removeEventListener("abort", abort);
      }
    });
  },
);

// Opaque ownership must be re-read after invalidation; otherwise selection spins in microtasks.
it.each(["parent model change", "late cron registration"])(
  "settles selection of materialized opaque-ownership rows after %s",
  async (invalidation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const parentKey = "agent:main:parent";
      const parent = { sessionId: "parent", updatedAt: 1 };
      const keys = Array.from({ length: 3 }, (_, index) => `agent:main:opaque-${index}`);
      seedRow(parentKey, parent);
      for (const [index, sessionKey] of keys.entries()) {
        seedRow(sessionKey, {
          sessionId: `opaque-${index}`,
          updatedAt: index + 1,
          agentHarnessId: "row-opaque",
          modelSelectionLocked: true,
          parentSessionKey: parentKey,
        });
      }
      // A pinned harness without dependency-tracked ownership yields opaque ownership facts.
      using _ = installHarness("row-opaque");
      registerSessionAutomationSource(null);
      let preparationPasses = 0;
      let guardSelection = false;
      const createMembership = membership.createSessionMembershipProjection;
      vi.spyOn(membership, "createSessionMembershipProjection").mockImplementation(() => {
        const owner = createMembership();
        const prepare = owner.prepare;
        // A microtask spin starves timers. Bound loop passes at a real awaited boundary,
        // preserving membership preparation so the regression rejects instead of hanging.
        vi.spyOn(owner, "prepare").mockImplementation(() => {
          if (guardSelection && ++preparationPasses > 8) {
            throw new Error("Selection preparation made no progress after 8 passes");
          }
          return prepare();
        });
        return owner;
      });
      using foreground = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      try {
        // Materialize the rows so each retains accepted database facts, as a served list does.
        await listProjectedSessions({ projection, opts: {} });
        expect(projection.dirtyRowCount).toBe(0);
        expect(projection.needsSelectionPreparation()).toBe(false);
        const rows = keys.map((key) => projection.capture({ agentId: "main", key })!);
        const retained = rows.map((row) => row.retainedDatabaseFacts);

        if (invalidation === "parent model change") {
          // Parent publication fans out through archive.markRelated without expiring child facts.
          seedRow(parentKey, {
            ...parent,
            providerOverride: "unit-test",
            modelOverride: "changed",
          });
        } else {
          // server-cron registers after startup; loaded bindings re-dirty already served rows.
          const jobs = keys.map((key, index) =>
            cronTestJob({
              id: `binding-${index}`,
              createdAtMs: 1,
              updatedAtMs: 1,
              sessionTarget: `session:${key}`,
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "Synthetic binding" },
            }),
          );
          registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
        }
        expect(projection.dirtyRowCount).toBeGreaterThanOrEqual(keys.length);
        for (const [index, row] of rows.entries()) {
          expect(projection.capture({ agentId: "main", key: row.key })).toBe(row);
          expect(row.materialized).toBeDefined();
          expect(row.pendingDatabaseFacts).toBeUndefined();
          expect(row.retainedDatabaseFacts).toBe(retained[index]);
        }
        expect(projection.needsSelectionPreparation()).toBe(true);

        guardSelection = true;
        try {
          await projection.prepareSelection();
        } finally {
          guardSelection = false;
        }
        expect(projection.needsSelectionPreparation()).toBe(false);
        const listed = await listProjectedSessions({ projection, opts: {} });
        expect(projection.dirtyRowCount).toBe(0);
        expect(listed.sessions.map((row) => row.key)).toEqual(expect.arrayContaining(keys));
        for (const key of keys) {
          expect(listed.sessions.find((row) => row.key === key)).toMatchObject(
            invalidation === "parent model change"
              ? { modelProvider: "unit-test", model: "changed" }
              : { hasAutomation: true },
          );
        }
      } finally {
        projection.dispose();
        foreground();
        registerSessionAutomationSource(null);
      }
    });
  },
);
