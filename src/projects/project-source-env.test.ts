import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  checkout: vi.fn(),
  listWorktrees: vi.fn(),
  readAgent: vi.fn(),
  patch: vi.fn(),
  forbiddenSqlite: vi.fn(() => {
    throw new Error("Project environment controls must not open SQLite");
  }),
}));

vi.mock("../agents/agent-scope-config.js", () => ({ withAgentRosterFactsBatch: vi.fn() }));
vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));
vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase: mocks.forbiddenSqlite,
}));
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  executeOpenClawStateWorker: mocks.execute,
}));
vi.mock("./project-checkout.js", () => ({
  withProjectCheckoutLifecycle: mocks.checkout,
  ProjectCheckoutError: class extends Error {},
  resolveProjectCheckout: vi.fn(),
  resolveProjectDirectory: vi.fn(),
}));
vi.mock("../state/openclaw-state-db-cache.js", () => ({
  captureOpenClawStateDatabaseReadAdmission: (databasePath: string) => ({
    databasePath,
    assertCurrent() {},
  }),
}));
vi.mock("../state/openclaw-state-db-async-lifecycle.js", () => ({
  getOpenClawDatabaseMaintenanceScope: () => undefined,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  runOpenClawStateWriteTransaction: mocks.forbiddenSqlite,
}));
vi.mock("./project-registry.kernel.js", () => ({
  ensureProjectRegistrySchema: mocks.forbiddenSqlite,
  removeProjectCheckoutReferenceInDatabase: mocks.forbiddenSqlite,
}));
vi.mock("../agents/worktrees/registry.js", () => ({
  listRegistryWorktreesForMigration: mocks.listWorktrees,
}));
vi.mock("../state/openclaw-agent-db-readonly.js", () => ({
  withOpenClawAgentDatabaseReadOnly: mocks.readAgent,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({ patchSessionEntryCore: mocks.patch }));
vi.mock("../config/sessions/session-accessor.sqlite-scope.js", () => ({
  resolveSqliteScope: (scope: unknown) => scope,
  toDatabaseOptions: (scope: unknown) => scope,
  getSessionKysely: mocks.forbiddenSqlite,
}));
vi.mock("../config/sessions/session-accessor.sqlite-entry-store.js", () => ({
  parseReadableSqliteSessionEntryRow: mocks.forbiddenSqlite,
}));
vi.mock("../infra/kysely-sync.js", () => ({ executeSqliteQuerySync: mocks.forbiddenSqlite }));

import type { SessionEntry } from "../config/sessions/types.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "../config/sessions/worktree-workspace-migration.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { selectStoredProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryRecord } from "./project-registry.types.js";

const root = path.resolve("/synthetic-project-state");
const project: ProjectRegistryRecord = {
  id: "registered-project",
  displayName: "Project",
  source: "registered",
  repoRoot: path.resolve("/synthetic-repository/project"),
};

async function withPausedProject<T>(
  start: (env: NodeJS.ProcessEnv) => Promise<T>,
  check: (result: T, env: NodeJS.ProcessEnv) => Promise<void> | void,
) {
  await withMockedPlatform("win32", async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: path.resolve("/synthetic-home"),
      USERPROFILE: path.resolve("/synthetic-home"),
      NODE_ENV: "test",
      OPENCLAW_TEST_FAST: "1",
      OpenClaw_State_Dir: root,
      OpenClaw_Supervisor_Mode: "external",
    };
    const entered = createDeferredCore();
    const projectRead = createDeferredCore<ProjectRegistryRecord>();
    let captured: OpenClawStateWorkerContext | undefined;
    mocks.execute.mockImplementation(async (context: OpenClawStateWorkerContext) => {
      captured = context;
      entered.resolve();
      return await projectRead.promise;
    });
    const pending = start(env);
    const joined = pending.catch(() => {});
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "Project read was bypassed");
      env.OpenClaw_State_Dir = path.resolve("/changed-project-state");
      env.OpenClaw_Supervisor_Mode = "other";
      projectRead.resolve(project);
      await check(await pending, env);
      expect(captured?.environment).toEqual({
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_SUPERVISOR_MODE: "external",
      });
      expect(captured?.admission.databasePath).toBe(path.join(root, "state", "openclaw.sqlite"));
      expect(mocks.forbiddenSqlite).not.toHaveBeenCalled();
    } finally {
      projectRead.resolve(project);
      await joined;
    }
  });
}

function expectSnapshot(snapshot: NodeJS.ProcessEnv | undefined, env: NodeJS.ProcessEnv) {
  expect(snapshot?.OPENCLAW_STATE_DIR).toBe(root);
  expect(snapshot).not.toBe(env);
  expect(Object.keys(snapshot ?? {})).toContain("OpenClaw_State_Dir");
  expect(Object.keys(snapshot ?? {})).not.toContain("OPENCLAW_STATE_DIR");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkout.mockResolvedValue(undefined);
  mocks.listWorktrees.mockReturnValue([]);
});

it("keeps the selector's Windows state snapshot through a caller environment change", async () => {
  await withPausedProject(
    (env) => selectStoredProjectRegistry(project.id, { env }),
    async (selected, env) => {
      expect(selected?.project).toEqual(project);
      await selected?.withRollback(async () => undefined);
      const checkoutOptions = mocks.checkout.mock.calls[0]?.[1];
      expect(checkoutOptions?.path).toBe(path.join(root, "state", "openclaw.sqlite"));
      expect(checkoutOptions?.env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
      expectSnapshot(checkoutOptions?.env, env);
    },
  );
});

it("keeps the migration's Windows state snapshot through the awaited project resolution", async () => {
  const sessionKey = "agent:main:dashboard:env-migration";
  const databasePath = path.resolve("/synthetic-agent/openclaw.sqlite");
  const entry: SessionEntry = {
    sessionId: "env-migration",
    updatedAt: 1,
    projectId: project.id,
    worktree: { id: "worktree", branch: "task", repoRoot: path.resolve("/synthetic-repository") },
  };
  let patchEnv: NodeJS.ProcessEnv | undefined;
  mocks.readAgent.mockReturnValue({ found: true, value: [{ databasePath, entry, sessionKey }] });
  mocks.patch.mockImplementation(
    async (
      scope: { env?: NodeJS.ProcessEnv },
      update: (current: SessionEntry) => Partial<SessionEntry> | null,
    ) => {
      patchEnv = scope.env;
      return { ...entry, ...update(entry) };
    },
  );
  await withPausedProject(
    (env) =>
      migrateManagedWorktreeCanonicalWorkspaces({
        mode: "doctor-fix",
        agentId: "main",
        cfg: {},
        env,
        storePath: databasePath,
      }),
    (result, env) => {
      expect(result).toEqual({ found: 1, repaired: 1 });
      expect(mocks.listWorktrees.mock.calls[0]?.[0].OPENCLAW_STATE_DIR).toBe(root);
      expectSnapshot(patchEnv, env);
      expect(env.OpenClaw_State_Dir).toBe(path.resolve("/changed-project-state"));
      expect(Object.hasOwn(env, "OPENCLAW_STATE_DIR")).toBe(false);
    },
  );
});
