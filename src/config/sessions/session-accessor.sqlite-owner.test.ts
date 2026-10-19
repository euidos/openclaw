import { afterEach, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS,
  SESSION_OWNER_COLUMN_DEFINITIONS,
} from "../../state/openclaw-agent-db-additive-columns.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { retainPreparedSessionEntryPredicate } from "./session-accessor.sqlite-entry-cache-publication-state.js";
import { assignSessionOwnerInWorker } from "./session-metadata-write.async.js";
import type { SessionEntry } from "./types.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

async function withOwnerSession(
  run: (
    scope: { agentId: string; env: NodeJS.ProcessEnv; sessionKey: string },
    entry: SessionEntry,
  ) => Promise<void>,
  overrides: Partial<SessionEntry> = {},
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:owner-test" };
    const entry: SessionEntry = {
      sessionId: "owner-test",
      updatedAt: 1,
      lifecycleRevision: "original-generation",
      createdActor: { type: "human", source: "profile", id: "profile-creator" },
      ...overrides,
    };
    await upsertSessionEntryCore(scope, entry);
    await run(scope, entry);
  });
}

function ownerAssignment(id = "profile-assigner") {
  return {
    actor: { type: "agent" as const, id: "research" },
    assignedBy: { type: "human" as const, id },
    assignedAt: 1234,
  };
}
function ownerParams({ actor: owner, ...assignment }: ReturnType<typeof ownerAssignment>) {
  return { owner, ...assignment };
}

it("guards incognito owner assignments without querying session rows", async () => {
  await withOwnerSession(
    async (scope, entry) => {
      const sql = observeHostDataSql();
      const assignment = ownerAssignment("profile-creator");
      const params = {
        ...ownerParams(assignment),
        expectedSessionId: entry.sessionId,
        expectedEntry: entry,
      };
      try {
        await expect(assignSessionOwnerInWorker(scope, params)).resolves.toEqual(assignment);
        await expect(
          assignSessionOwnerInWorker(scope, { ...params, expectedSessionId: "replaced-session" }),
        ).rejects.toThrow("session changed before collaboration mutation");
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(loadSessionEntry(scope)?.owner).toEqual(assignment);
    },
    { incognito: true },
  );
});

it("refuses stale session identity and lifecycle before assigning an owner", async () => {
  await withOwnerSession(async (scope) => {
    const expectedEntry = loadSessionEntry(scope)!;
    const assignment = {
      owner: { type: "agent" as const, id: "research" },
      assignedBy: { type: "human" as const, id: "profile-assigner" },
    };
    expect(() =>
      assignSessionOwner(scope, { ...assignment, expectedSessionId: "session-replaced" }),
    ).toThrow("session changed before owner assignment");
    expect(loadSessionEntry(scope)?.owner).toBeUndefined();

    await upsertSessionEntryCore(scope, {
      ...expectedEntry,
      lifecycleRevision: "replacement-generation",
    });
    expect(() =>
      assignSessionOwner(scope, {
        ...assignment,
        expectedSessionId: expectedEntry.sessionId,
        expectedEntry,
      }),
    ).toThrow("session ownership changed before owner assignment");
    expect(loadSessionEntry(scope)?.owner).toBeUndefined();
  });
});

it("lazily adds bare columns and preserves the assignment across reopen", async () => {
  await withOwnerSession(
    async (scope) => {
      const initial = openOpenClawAgentDatabase(scope);
      for (const { columnName, tableName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
        initial.db.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName};`);
      }
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();

      expect(loadSessionEntry(scope)).toMatchObject({
        createdActor: { type: "human", source: "profile", id: "profile-creator" },
      });
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      expect(() =>
        runOpenClawAgentWriteTransaction(() => {
          expect(
            assignSessionOwner(scope, {
              owner: { type: "agent", id: "rolled-back-owner" },
              assignedBy: { type: "human", id: "profile-assigner" },
              assignedAt: 1233,
            }),
          ).not.toBeNull();
          throw new Error("roll back owner schema");
        }, scope),
      ).toThrow("roll back owner schema");
      expect(loadSessionEntry(scope)?.owner).toBeUndefined();

      const assignment = ownerAssignment();
      const database = openOpenClawAgentDatabase(scope);
      const identity = readOpenClawAgentDatabaseIdentity(database).identity;
      if (typeof identity !== "string") {
        throw new Error("Expected a physical owner-assignment database");
      }
      const predicate = retainPreparedSessionEntryPredicate({
        databaseIdentity: `file:${identity}`,
        sessionKey: scope.sessionKey,
        entry: loadSessionEntry(scope),
        matches: (before, after) => before?.owner?.actor.id === after?.owner?.actor.id,
      });
      try {
        expect(predicate.isCurrent()).toBe(true);
        expect(assignSessionOwner(scope, ownerParams(assignment))).toEqual(assignment);
        expect(predicate.isCurrent()).toBe(false);
      } finally {
        predicate.release();
      }
      expect(loadSessionEntry(scope)?.owner).toEqual(assignment);

      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      expect(loadSessionEntry(scope)?.owner).toEqual(assignment);
      const reopened = openOpenClawAgentDatabase(scope);
      const columns = reopened.db.prepare("PRAGMA table_info(session_nodes)").all();
      expect(columns.some((column) => column.name === "legacy_acp_migration_json")).toBe(false);
      for (const definition of SESSION_OWNER_COLUMN_DEFINITIONS) {
        expect(columns.find((column) => column.name === definition.columnName)).toMatchObject({
          type: definition.dataType,
          notnull: 0,
          dflt_value: null,
        });
      }
    },
    { lifecycleRevision: undefined },
  );
});
