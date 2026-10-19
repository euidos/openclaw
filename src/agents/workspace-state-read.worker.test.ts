import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { DuplicateAgentError } from "./agent-create-error.js";
import { resolveBootstrapFilesForPreparation } from "./bootstrap-files.js";
import { readWorkspaceFileCache, writeWorkspaceFileCache } from "./workspace-file-cache.js";
import { assertConfiguredWorkspaceStateReady } from "./workspace-state-dirs.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  deleteWorkspaceState,
  mergeWorkspaceSetupState as merge,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot as read,
  replaceWorkspaceAttestation as attest,
} from "./workspace-state-store.js";

const WORKSPACE_ATTESTATION_RECENT_MS = 24 * 60 * 60 * 1000;
const seededAt = "2026-07-16T01:00:00.000Z";
const completedAt = "2026-07-16T02:00:00.000Z";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-reader-" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

async function seed() {
  await merge(state.workspaceDir, { bootstrapSeededAt: seededAt }, 1_000);
  await attest({
    workspaceDir: state.workspaceDir,
    attestedAtMs: 1_000,
    nowMs: 1_000,
    generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
  });
  return await read(state.workspaceDir);
}

async function withoutMainThreadSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeMainThreadSql();
  try {
    const result = await run();
    sql.expectIdle();
    return result;
  } finally {
    sql.restore();
  }
}

it("reuses unchanged workspace facts and refreshes them after each owning write", async () => {
  expect((await read(state.workspaceDir)).setupExists).toBe(false);
  const initial = await seed();
  expect(initial.setup.bootstrapSeededAt).toBe(seededAt);
  const execute = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
  const unchanged = await withoutMainThreadSql(() => read(state.workspaceDir));
  expect(unchanged).toEqual(initial);
  expect(execute).not.toHaveBeenCalled();

  await merge(state.workspaceDir, { setupCompletedAt: completedAt });
  expect((await read(state.workspaceDir)).setup.setupCompletedAt).toBe(completedAt);
  await attest({
    workspaceDir: state.workspaceDir,
    attestedAtMs: 2_000,
    nowMs: 2_000,
    generatedHashes: new Map([["TOOLS.md", "b".repeat(64)]]),
  });
  expect((await read(state.workspaceDir)).attestation).toEqual({
    attestedAtMs: 2_000,
    generatedHashes: new Map([["TOOLS.md", "b".repeat(64)]]),
  });
  await deleteWorkspaceState(prepareWorkspaceStateDeletion(state.workspaceDir));
  expect(await read(state.workspaceDir)).toMatchObject({
    setupExists: false,
    setup: { version: 1 },
  });
});

it("rolls back setup when a recovery hold arrives after caller preparation", async () => {
  const before = await seed();
  const recoveryHoldPredicate = { agentId: "new", held: [], applies: true };
  runOpenClawStateWriteTransaction((database) => {
    database.db.exec("DROP TABLE agent_deletion_journal");
    reconstructAgentDeletionJournal(database, [
      { agentId: "new", path: state.path("held.sqlite") },
    ]);
  });
  await withoutMainThreadSql(async () => {
    const refusal = await merge(state.workspaceDir, { setupCompletedAt: completedAt }, 2_000, {
      recoveryHoldPredicate,
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DuplicateAgentError);
    expect(refusal).toMatchObject({
      message:
        "Agent new has held databases. Restore its original agentDir and session.store configuration, then run agents add explicitly to restore the preserved store.",
    });
    expect(await read(state.workspaceDir)).toEqual(before);
  });
});

it.each(["merge", "delete"] as const)(
  "rejects revoked authority at transaction and commit for %s",
  async (operation) => {
    const before = await seed();
    const alias = state.path("grant-alias");
    fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
    for (const stage of ["transaction", "commit"] as const) {
      let retired = false;
      const refusal = new Error("workspace owner retired");
      const spy = probe.admission(workerAdmission, (request, grant, admit) => {
        retired ||= request.stage === stage;
        admit(request, grant);
      });
      const options = {
        assertCurrent: () => {
          if (retired) {
            throw refusal;
          }
        },
      };
      const pending =
        operation === "merge"
          ? merge(alias, { setupCompletedAt: completedAt }, 2_000, options)
          : deleteWorkspaceState(prepareWorkspaceStateDeletion(alias), options);
      await expect(pending).rejects.toBe(refusal);
      spy.mockRestore();
      expect(retired).toBe(true);
      expect(await read(state.workspaceDir)).toEqual(before);
    }
    fs.unlinkSync(alias);
    expect((await read(alias)).setupExists).toBe(false);
  },
);

it.each(["transaction", "commit"] as const)(
  "refuses expiry when workspace files reappear at %s admission",
  async (stage) => {
    const before = await seed();
    const filePath = path.join(state.workspaceDir, "AGENTS.md");
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    let restored = false;
    const spy = probe.admission(workerAdmission, (request, grant, admit) => {
      if (!restored && request.stage === stage) {
        fs.writeFileSync(filePath, "Restored workspace instructions.");
        restored = true;
      }
      admit(request, grant);
    });
    await expect(
      clearExpiredWorkspaceStateForVanishedWorkspace(
        state.workspaceDir,
        WORKSPACE_ATTESTATION_RECENT_MS + 2_001,
      ),
    ).rejects.toThrow("Workspace filesystem changed");
    spy.mockRestore();
    expect(restored).toBe(true);
    expect(await read(state.workspaceDir)).toEqual(before);
    expect(readWorkspaceFileCache(filePath, "identity")).toBe("cached");
  },
);

it.each(["expiry", "deletion"] as const)(
  "retires committed %s cache entries when result delivery fails without replay",
  async (cleanup) => {
    await seed();
    const filePath = path.join(state.workspaceDir, "AGENTS.md");
    writeWorkspaceFileCache({ filePath, content: "cached", identity: "identity" });
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    const spy = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (...args) => {
        await execute(...args);
        throw new Error("workspace cleanup reply lost");
      });
    await expect(
      cleanup === "deletion"
        ? deleteWorkspaceState(prepareWorkspaceStateDeletion(state.workspaceDir))
        : clearExpiredWorkspaceStateForVanishedWorkspace(
            state.workspaceDir,
            WORKSPACE_ATTESTATION_RECENT_MS + 2_001,
          ),
    ).rejects.toThrow("workspace cleanup reply lost");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(readWorkspaceFileCache(filePath, "identity")).toBeUndefined();
    expect((await read(state.workspaceDir)).setupExists).toBe(false);
  },
);

it("keeps captured first-writer setup milestones across queued merges and reopen", async () => {
  await seed();
  const next = { setupCompletedAt: completedAt };
  const first = merge(state.workspaceDir, next, 2_000);
  next.setupCompletedAt = "2026-07-17T02:00:00.000Z";
  const second = merge(state.workspaceDir, next, 3_000);
  expect((await first).setupCompletedAt).toBe(completedAt);
  expect((await second).setupCompletedAt).toBe(completedAt);
  await closeOpenClawStateDatabaseAsync();
  expect((await read(state.workspaceDir)).setup.setupCompletedAt).toBe(completedAt);
});

it("rolls back alias registration when its symlink is repointed before commit", async () => {
  const before = await seed();
  const alias = state.path("pending-alias");
  const replacement = state.path("new-target");
  fs.mkdirSync(replacement);
  fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === "commit") {
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
    }
    admit(request, grant);
  });
  await expect(read(alias)).rejects.toBeInstanceOf(WorkspaceAliasRepointedError);
  spy.mockRestore();
  fs.unlinkSync(alias);
  expect((await read(alias)).setupExists).toBe(false);
  expect(await read(state.workspaceDir)).toEqual(before);
});

it("joins a granted workspace mutation before closing its database", async () => {
  await seed();
  let close: Promise<void> | undefined;
  let closed = false;
  const spy = probe.admission(workerAdmission, (request, grant, admit) => {
    admit(request, () => {
      const granted = grant();
      if (request.stage === "commit") {
        close = closeOpenClawStateDatabaseAsync().then(() => {
          closed = true;
        });
        expect(closed).toBe(false);
      }
      return granted;
    });
  });
  await expect(
    merge(state.workspaceDir, { setupCompletedAt: completedAt }, 2_000),
  ).rejects.toMatchObject({
    message: "SQLite committed facts publication failed",
    code: "outcome-unknown",
    cause: {
      message: "OpenClaw state database read admission is closed",
      code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
    },
  });
  expect(close).toBeDefined();
  await close;
  spy.mockRestore();
  expect(closed).toBe(true);
  expect((await read(state.workspaceDir)).setup.setupCompletedAt).toBe(completedAt);
});

it.each([false, true])(
  "prepares bootstrap files for completed=%s without main-thread SQL",
  async (completed) => {
    await seed();
    fs.mkdirSync(state.workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(state.workspaceDir, "AGENTS.md"), "Synthetic agent instructions.\n");
    fs.writeFileSync(
      path.join(state.workspaceDir, "BOOTSTRAP.md"),
      "Synthetic setup instructions.\n",
    );
    if (completed) {
      await merge(state.workspaceDir, { setupCompletedAt: completedAt });
    }
    await closeOpenClawStateDatabaseAsync();
    const files = await withoutMainThreadSql(() =>
      resolveBootstrapFilesForPreparation({ workspaceDir: state.workspaceDir }),
    );
    expect(files.find((file) => file.name === "AGENTS.md")?.content).toContain(
      "Synthetic agent instructions.",
    );
    // Preparation treats read errors as incomplete setup, so success alone is insufficient.
    expect(files.some((file) => file.name === "BOOTSTRAP.md")).toBe(!completed);
  },
);

it("keeps workspace reads on the selected composite snapshot", async () => {
  const initial = await seed();
  await withOpenClawStateDatabaseReadSnapshot(async () => {
    await merge(state.workspaceDir, { setupCompletedAt: completedAt });
    expect(await withoutMainThreadSql(() => read(state.workspaceDir, { readOnly: true }))).toEqual(
      initial,
    );
  });
  expect((await read(state.workspaceDir, { readOnly: true })).setup.setupCompletedAt).toBe(
    completedAt,
  );
});

it("reads committed workspace state while the cached writer has an open transaction", async () => {
  const expected = await seed();
  const database = openOpenClawStateDatabase();
  database.db.exec("BEGIN IMMEDIATE");
  try {
    database.db.prepare("UPDATE workspace_setup_state SET setup_completed_at = ?").run(completedAt);
    expect(
      await withoutMainThreadSql(() => read(state.workspaceDir, { database, readOnly: true })),
    ).toEqual(expected);
    expect(database.db.isOpen).toBe(true);
  } finally {
    database.db.exec("ROLLBACK");
  }
});

it("preserves repointed workspace alias error identity and repair details", async () => {
  await seed();
  const alias = state.path("alias");
  const replacement = state.path("replacement");
  fs.mkdirSync(replacement);
  fs.symlinkSync(state.workspaceDir, alias, process.platform === "win32" ? "junction" : "dir");
  await read(alias);
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
  await closeOpenClawStateDatabaseAsync();
  const error = await withoutMainThreadSql(() =>
    assertConfiguredWorkspaceStateReady({
      cfg: { agents: { defaults: { workspace: alias, sandbox: { mode: "off" } } } },
      env: state.env,
      operation: "doctor",
    }).catch((caught: unknown) => caught),
  );
  expect(error).toBeInstanceOf(WorkspaceAliasRepointedError);
  expect(error).toMatchObject({
    aliasPath: path.normalize(alias),
    storedWorkspacePath: path.normalize(state.workspaceDir),
    currentWorkspacePath: path.normalize(replacement),
  });
});
