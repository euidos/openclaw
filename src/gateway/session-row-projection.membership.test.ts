import type { StatementSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  listSessionEntriesReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import { updateSessionGroupCategoriesInWorker } from "../config/sessions/session-group-categories.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionGroupMembership } from "./session-group-membership.read.js";
import { putSessionGroups } from "./session-groups.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createTestProjection } from "./session-row-projection.read-fixture.test-support.js";

function observeQueries(prototype: StatementSync) {
  const { queries, restore } = observeSqliteReadSql(prototype);
  return {
    expectNoMembershipSql: () =>
      expect(queries.filter((sql) => /\bsession_(members|participants)\b/i.test(sql))).toEqual([]),
    [Symbol.dispose]: restore,
  };
}

async function observedProjection<T>(read: (projection: SessionRowProjection) => T) {
  let projection: SessionRowProjection | undefined;
  let observing = false;
  const observed: T[] = [];
  const stop = sessionChanges.subscribe(() => {
    if (observing && projection) {
      observed.push(read(projection));
    }
  });
  try {
    projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
    await projection.ensureMaterialized();
    const current = projection;
    return Object.assign(current, {
      observed,
      start: () => {
        observing = true;
      },
      [Symbol.dispose]: () => {
        stop();
        current.dispose();
      },
    });
  } catch (error) {
    stop();
    projection?.dispose();
    throw error;
  }
}

const participant = (id: string) => ({ identity: { type: "agent" as const, id } });
const participantBytes = (entry: ReturnType<typeof loadSessionEntry>) =>
  JSON.stringify({ participants: entry?.participants, participantCount: entry?.participantCount });

it("publishes byte-identical group and participant facts without host membership SQL during cold admission, row refresh or 50 viewer reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const scope = { agentId: "main", sessionKey: "agent:main:projected-members" };
    await upsertSessionEntryCore(scope, {
      sessionId: "projected-members",
      updatedAt: Date.now(),
      category: " Work ",
    });
    addSessionMember(scope, { identityId: "viewer", addedBy: "owner", addedAt: 1 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "research" }, promptedAt: 2 });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "main" }, promptedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const prototype: StatementSync = Object.getPrototypeOf(database.db.prepare("SELECT 1"));
    // Profile display admission has its own owner; keep this boundary on the cold session store.
    const profiles = await prepareUserProfileCatalog();
    const admissionReads = observeHostDataSql();
    let projection: SessionRowProjection | undefined;
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    try {
      projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      await projection.ensureMaterialized();
      admissionReads.restore();
      expect(admissionReads.queries).toEqual([]);
      const nativeListEntry = listSessionEntriesReadOnly({
        agentId: scope.agentId,
        projection: "list",
      }).find(({ sessionKey }) => sessionKey === scope.sessionKey)?.entry;
      expect(nativeListEntry).toMatchObject({
        participants: [participant("main"), participant("research")],
        participantCount: 2,
      });
      const nativeEntry = loadSessionEntry(scope);
      expect(nativeEntry).toMatchObject({
        participants: nativeListEntry?.participants,
        participantCount: 2,
      });
      expect(participantBytes(projection.describe(query)?.entry)).toBe(
        participantBytes(nativeEntry),
      );
      const goldenGroups = JSON.stringify([
        ...new Map(readSessionGroupMembership({}, process.env).groups),
      ]);
      const goldenParticipants = JSON.stringify(projection.snapshot(query).row?.participants);
      expect(projection.describe(query)?.membership.has("viewer")).toBe(true);
      {
        using reads = observeQueries(prototype);
        for (let viewer = 0; viewer < 50; viewer++) {
          expect(JSON.stringify([...projection.sessionGroupTargets()])).toBe(goldenGroups);
          expect(JSON.stringify(projection.snapshot(query).row?.participants)).toBe(
            goldenParticipants,
          );
          expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(true);
        }
        reads.expectNoMembershipSql();
      }
      // Revocation is visible before full-row materialization or another awaited worker read.
      removeSessionMember(scope, "viewer");
      expect(projection.hasMembership(database.path, scope.sessionKey, "viewer")).toBe(false);
      {
        using refreshReads = observeQueries(prototype);
        await projection.ensureMaterialized();
        await projection.prepareMembership();
        expect(projection.describe(query)?.membership.has("viewer")).toBe(false);
        expect(JSON.stringify(projection.snapshot(query).row?.participants)).toBe(
          goldenParticipants,
        );
        refreshReads.expectNoMembershipSql();
      }
    } finally {
      admissionReads.restore();
      projection?.dispose();
      profiles.release();
    }
  });
});

it("publishes final replacement facts to observers registered before the projection", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const scope = { agentId: "main", sessionKey: "agent:main:transaction-members" };
    await upsertSessionEntryCore(scope, { sessionId: "old", updatedAt: 1, category: "old" });
    addSessionMember(scope, { identityId: "old-viewer", addedBy: "owner" });
    recordSessionParticipant(scope, {
      identity: { type: "agent", id: "research" },
      promptedAt: 1,
    });
    const database = openOpenClawAgentDatabase(scope);
    const replace = (sessionId: string, updatedAt: number) =>
      replaceSessionEntrySync(scope, { sessionId, updatedAt, category: sessionId });
    using projection = await observedProjection((read) => ({
      old: read.hasMembership(database.path, scope.sessionKey, "old-viewer"),
      current: read.hasMembership(database.path, scope.sessionKey, "current-viewer"),
      transient: read.hasMembership(database.path, scope.sessionKey, "transient"),
      groups: [...read.sessionGroupTargets().keys()],
    }));
    const { observed } = projection;
    projection.start();
    runOpenClawAgentWriteTransaction(() => {
      replace("intermediate", 2);
      replace("current", 3);
      addSessionMember(scope, { identityId: "transient", addedBy: "owner" });
      removeSessionMember(scope, "transient");
      addSessionMember(scope, { identityId: "current-viewer", addedBy: "owner" });
      recordSessionParticipant(scope, {
        identity: { type: "agent", id: "reviewer" },
        promptedAt: 2,
      });
      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          replace("rolled-back", 4);
          addSessionMember(scope, { identityId: "rolled-back", addedBy: "owner" });
          throw new Error("rollback savepoint");
        }, scope),
      ).toThrow("rollback savepoint");
      expect(observed).toEqual([]);
    }, scope);
    expect(observed.length).toBeGreaterThan(0);
    for (const value of observed) {
      expect(value).toEqual({
        old: false,
        current: true,
        transient: false,
        groups: ["current"],
      });
    }
    expect(projection.needsMembershipPreparation()).toBe(false);
    const query = { agentId: scope.agentId, key: scope.sessionKey };
    const entry = await withReadySessionRows(
      projection,
      () => [query],
      (read) => read.describe(query)?.entry,
    );
    expect(entry).toMatchObject({
      sessionId: "current",
      category: "current",
      participants: [participant("research"), participant("reviewer")],
      participantCount: 2,
    });
  });
});

it("installs every category in a worker reply before the first row observer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {};
    setRuntimeConfigSnapshot(cfg);
    await putSessionGroups({ cfg, names: ["work", "done"] });
    const keys = ["agent:main:category-a", "agent:main:category-b"];
    for (const sessionKey of keys) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          category: "work",
        },
      );
    }
    using projection = await observedProjection((read) => [...read.sessionGroupTargets()]);
    const { observed } = projection;
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    projection.start();
    expect(
      await updateSessionGroupCategoriesInWorker({
        scope: { agentId: "main", sessionKey: "", storePath: database.path },
        from: "work",
        to: "done",
      }),
    ).toBe(2);
    expect(observed).toHaveLength(2);
    for (const value of observed) {
      expect(value).toEqual([
        ["done", keys.map((sessionKey) => ({ agentId: "main", sessionKey }))],
      ]);
    }
    expect(projection.needsMembershipPreparation()).toBe(false);
  });
});
