import { afterEach, beforeEach, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  applySessionEntryReplacements,
  assignSessionOwner,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readSessionEntrySelectionSnapshot,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { readSessionEntryReplacementState } from "./session-accessor.sqlite-replacement-read.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";

const tempDirs: string[] = [];
let storePath: string;
let scope: { sessionKey: string; storePath: string };

beforeEach(async () => {
  storePath = `${makeTempDir(tempDirs, "replacement-cas")}/openclaw-agent.sqlite`;
  scope = { sessionKey: "agent:main:replacement-row", storePath };
  await upsertSessionEntryCore(scope, {
    model: "base",
    sessionId: "replacement-row",
    updatedAt: 10,
  });
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  cleanupTempDirs(tempDirs);
});

const databaseOptions = () => ({ agentId: "main", path: storePath });
const openDatabase = () => openOpenClawAgentDatabase(databaseOptions());

it("hydrates replacement candidates once while preserving detached snapshots", async () => {
  const prompt = "synthetic replacement payload ".repeat(8192);
  for (const suffix of ["a", "b"]) {
    await upsertSessionEntryCore(
      { storePath, sessionKey: `agent:main:payload-${suffix}` },
      {
        sessionId: `payload-${suffix}`,
        updatedAt: 10,
        skillsSnapshot: { prompt, skills: [] },
      },
    );
  }
  const db = openDatabase();
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(db.db),
    ["entries"],
    (sql) => (/\bfrom\s+"session_nodes"/iu.test(sql) ? "entries" : null),
  );
  try {
    const snapshot = readSessionEntryReplacementState(db, {});
    const selected = snapshot.entries.filter(({ sessionKey }) => sessionKey.includes("payload-"));
    expect(selected).toHaveLength(2);
    for (const { entry } of selected) {
      expect(entry.skillsSnapshot?.prompt).toBe(prompt);
      if (entry.skillsSnapshot) {
        entry.skillsSnapshot.prompt = "detached mutation";
      }
    }
    // Two full candidate payloads, with room for their small metadata; enumeration must not hydrate them again.
    expect(reads.textBytes.entries).toBeLessThan(prompt.length * 3);
  } finally {
    reads.restore();
  }
  expect(
    loadSessionEntry({ storePath, sessionKey: "agent:main:payload-a" })?.skillsSnapshot?.prompt,
  ).toBe(prompt);
});

it("publishes detached persisted bytes and participant facts without rereading the writer", () => {
  recordSessionParticipant(scope, {
    identity: { type: "agent", id: "contributor" },
    promptedAt: 1,
  });
  runOpenClawAgentWriteTransaction((database) => {
    const snapshot = readSessionEntrySelectionSnapshot(database, scope.sessionKey, true, true)[0]!;
    const previous = snapshot.entry;
    const postimages: SessionEntryWritePostimages = new Map();
    const written = writeSessionEntry(
      database,
      scope.sessionKey,
      {
        ...previous,
        model: "committed",
        participantCount: 99,
        participants: [{ identity: { type: "agent", id: "forged" } }],
        skillsSnapshot: { prompt: "private saved prompt", skills: [] },
      },
      {
        canonicalPreviousEntry: previous,
        canonicalPreviousRow: snapshot.row,
        canonicalPreviousWindow: snapshot.window,
        canonicalPreviousSideTables: snapshot.sideTables,
        postimages,
      },
    );
    const changes = {
      previous: new Map([[scope.sessionKey, previous]]),
      current: new Map([[scope.sessionKey, written]]),
      pendingArchiveRecovery: false,
      membershipInvalidatedKeys: [],
      maintenancePlans: [],
    };
    const reads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["publication"],
      (sql) =>
        /\bfrom\s+"(?:session_nodes|session_participants|session_windows)"/iu.test(sql)
          ? "publication"
          : null,
    );
    try {
      written.model = "not committed";
      if (previous.participants?.[0]) {
        previous.participants[0].identity.id = "caller-owned";
      }
      const publication = prepareSessionEntryReplacementPublication(changes, database, {
        captureFullFacts: true,
        postimages,
      });
      expect(publication.current.get(scope.sessionKey)).toMatchObject({
        model: "committed",
        participants: [{ identity: { type: "agent", id: "contributor" } }],
        participantCount: 1,
      });
      expect(publication.current.get(scope.sessionKey)?.skillsSnapshot).toBeUndefined();
      expect(publication.fullEntries?.get(scope.sessionKey)?.skillsSnapshot?.prompt).toBe(
        "private saved prompt",
      );
      expect(reads.counts.publication).toBe(0);
    } finally {
      reads.restore();
    }
  }, databaseOptions());
  expect(loadSessionEntry(scope)).toMatchObject({
    model: "committed",
    skillsSnapshot: { prompt: "private saved prompt" },
    participants: [{ identity: { type: "agent", id: "contributor" } }],
  });
});

it.each(["row deletion", "owner reassignment"] as const)(
  "rejects stale replacement after %s",
  async (change) => {
    const assignedBy = { id: "assigner", type: "human" as const };
    const reassign = (id: string) =>
      assignSessionOwner(scope, { assignedBy, owner: { id, type: "human" } });
    if (change === "owner reassignment") {
      reassign("owner-a");
    }
    await expect(
      applySessionEntryReplacements({
        sessionKeys: [scope.sessionKey],
        storePath,
        update: (entries) => {
          if (change === "row deletion") {
            openDatabase()
              .db.prepare("DELETE FROM session_nodes WHERE session_key = ?")
              .run(scope.sessionKey);
          } else {
            expect(entries[0]?.entry.owner?.actor.id).toBe("owner-a");
            reassign("owner-b");
          }
          return {
            replacements: entries.map(({ entry, sessionKey }) => ({
              entry: { ...entry, model: "stale-replacement" },
              sessionKey,
            })),
            result: undefined,
          };
        },
      }),
    ).rejects.toThrow("changed before replacement");
    const current = loadSessionEntry({ ...scope, readConsistency: "latest" });
    if (change === "row deletion") {
      expect(current).toBeUndefined();
    } else {
      expect(current).toMatchObject({
        model: "base",
        owner: { actor: { id: "owner-b", type: "human" } },
        sessionId: "replacement-row",
      });
    }
  },
);
