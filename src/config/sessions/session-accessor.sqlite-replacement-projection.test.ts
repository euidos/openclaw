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

it("detaches writer postimages from returned entries and previous participant facts", () => {
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
      { ...previous, model: "committed" },
      {
        canonicalPreviousEntry: previous,
        canonicalPreviousRow: snapshot.row,
        canonicalPreviousWindow: snapshot.window,
        canonicalPreviousSideTables: snapshot.sideTables,
        postimages,
      },
    );
    written.model = "not committed";
    previous.participants![0]!.identity.id = "caller-owned";
    expect(postimages.get(scope.sessionKey)?.entry).toMatchObject({
      model: "committed",
      participants: [{ identity: { type: "agent", id: "contributor" } }],
      participantCount: 1,
    });
  }, databaseOptions());
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
