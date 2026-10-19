import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabasePath,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import * as reconcilePool from "../config/sessions/session-transcript-reconcile-pool.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../config/sessions/session-transcript-reconcile.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { createOpenClawTestState, withOpenClawTestState } from "../plugin-sdk/test-state.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openClawStateDatabaseCache,
} from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, captureFullEnv, setTestEnvValue, withEnvAsync } from "./env.js";
import * as sessionCleanup from "./session-state-cleanup.js";

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

const removeOptions = { recursive: true, force: true, maxRetries: 20, retryDelay: 25 };
function makeAuthStore() {
  return {
    version: 1,
    profiles: { "openai:test": { type: "api_key" as const, provider: "openai", key: "sk-test" } },
  };
}
const readEnv = (keys: string[], env = process.env) =>
  Object.fromEntries(keys.map((key) => [key, env[key]]));
function expectEnv(expected: NodeJS.ProcessEnv, env = process.env) {
  expect(readEnv(Object.keys(expected), env)).toEqual(expected);
}
function expectOpen(isOpen: boolean, ...databases: Pick<DatabaseSync, "isOpen">[]) {
  for (const database of databases) {
    expect(database).toMatchObject({ isOpen });
  }
}
function saveAuthFixture(dir: string) {
  saveAuthProfileStore(makeAuthStore(), dir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

async function createRollbackFixture() {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "state-rollback-")));
  const owner = createVitestResourceOwner(parent);
  const lifetime = createFixtureLifetime(parent);
  return { parent, owner, lifetime, prefix: path.join(path.basename(parent), "fixture-") };
}

describe("openclaw test state", () => {
  it.each(["filesystem", "environment"])(
    "retains failed %s rollback through the cleanup verifier",
    async (stage) => {
      const { parent, owner, lifetime, prefix } = await createRollbackFixture();
      const environment = captureFullEnv();
      const previousHome = path.join(parent, "previous-home");
      setTestEnvValue("HOME", previousHome);
      const acquisitionFailure = new Error("state canonicalization failed");
      const cleanupFailure = new Error("state acquisition rollback failed");
      const mkdtemp = fs.mkdtemp;
      const rm = fs.rm;
      const set = Reflect.set;
      let writes = 0;
      let allocatedRoot: string | undefined;
      const allocated = vi.spyOn(fs, "mkdtemp").mockImplementation(async (...args) => {
        const root = await mkdtemp(...args);
        if (args[0].endsWith(prefix)) {
          allocatedRoot = root;
        }
        return root;
      });
      const removal = vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
        if (stage === "filesystem" && args[0] === allocatedRoot) {
          throw cleanupFailure;
        }
        return rm(...args);
      });
      const fault =
        stage === "filesystem"
          ? vi.spyOn(fs, "realpath").mockRejectedValueOnce(acquisitionFailure)
          : vi.spyOn(Reflect, "set").mockImplementation((...args) => {
              const result = set(...args);
              if (args[0] === process.env && args[1] === "HOME") {
                if (++writes === 1) {
                  throw acquisitionFailure;
                }
                fault.mockRestore();
                throw cleanupFailure;
              }
              return result;
            });
      const sessionDrain = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");
      try {
        await expect(
          lifetime.run(() =>
            createOpenClawTestState({
              prefix,
              applyEnv: stage === "environment",
              verifyCleanup: lifetime.verifyCleanup,
            }),
          ),
        ).rejects.toBe(cleanupFailure);
        if (stage === "environment") {
          expect(writes).toBe(2);
          expect(process.env.HOME).toBe(previousHome);
          expect(removal).not.toHaveBeenCalled();
          await expect(lifetime.cleanup()).rejects.toMatchObject({ errors: [cleanupFailure] });
        } else {
          await expect(lifetime.cleanup()).rejects.toThrow("Fixture cleanup unverified");
        }
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        expect(allocatedRoot).toBeDefined();
        await expect(fs.stat(allocatedRoot!)).resolves.toBeDefined();
        expect(sessionDrain).not.toHaveBeenCalled();
        if (stage === "environment") {
          expect(removal).not.toHaveBeenCalled();
        }
      } finally {
        allocated.mockRestore();
        fault.mockRestore();
        removal.mockRestore();
        sessionDrain.mockRestore();
        environment.restore();
        await lifetime.cleanup().catch(() => undefined);
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("joins callback descendants before beginning state release", async () => {
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    let background: Promise<void> | undefined;
    let fixtureStateDir: string | undefined;
    let selectedStateDir: string | undefined;
    const observedCleanup = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");
    const operation = withOpenClawTestState({ label: "callback-descendant" }, async (state) => {
      fixtureStateDir = state.stateDir;
      background = trackAsyncWork(async () => {
        entered.resolve();
        await gate.promise;
        selectedStateDir = process.env.OPENCLAW_STATE_DIR;
      });
    });
    try {
      await entered.promise;
      await nextTurn();
      expect.soft(observedCleanup).not.toHaveBeenCalled();
      expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(fixtureStateDir);
    } finally {
      gate.resolve();
      await background;
      await operation;
      observedCleanup.mockRestore();
    }
    expect(selectedStateDir).toBe(fixtureStateDir);
  });

  it.each(["cleanup", "restoreEnv"] as const)(
    "joins concurrent %s callers before restoring selectors",
    async (method) => {
      const state = await createOpenClawTestState({ label: "concurrent-release" });
      const gate = createDeferredCore();
      const drain = vi
        .spyOn(sessionCleanup, "cleanupSessionStateForTest")
        .mockReturnValue(gate.promise);
      const settled: number[] = [];
      const releases = [0, 1].map((index) =>
        Promise.resolve(state[method]()).then(() => settled.push(index)),
      );
      try {
        await nextTurn();
        expect.soft(settled).toEqual([]);
        expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        expect.soft(drain).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await Promise.all(releases);
        drain.mockRestore();
        await state.cleanup();
      }
      expect(settled).toHaveLength(2);
      expect(() => state.applyEnv()).toThrow("released OpenClaw test state");
    },
  );

  it.each(["cleanup", "restoreEnv"] as const)(
    "retains selectors and files when %s cannot drain",
    async (method) => {
      const environment = captureFullEnv();
      const state = await createOpenClawTestState({ label: "failed-release" });
      const fault = new Error("synthetic drain failed");
      const drain = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest").mockRejectedValue(fault);
      try {
        const results = await Promise.allSettled([state[method](), state[method]()]);
        expect.soft(results).toEqual([
          { status: "rejected", reason: fault },
          { status: "rejected", reason: fault },
        ]);
        expect.soft(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        await expect.soft(fs.stat(state.root)).resolves.toBeDefined();
      } finally {
        // The injected drain has settled and owns no real work. Dispose this
        // deliberately retained fixture without borrowing a failed release API.
        drain.mockRestore();
        environment.restore();
        await fs.rm(state.root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { stage: "realpath", layout: "home", verifier: "default" },
    { stage: "home", layout: "split", verifier: "default" },
    { stage: "config", layout: "split", verifier: "default" },
    { stage: "environment", layout: "home", verifier: "default" },
    { stage: "environment", layout: "home", verifier: "lifetime" },
  ] as const)(
    "rolls back $stage acquisition in $layout layout ($verifier)",
    async ({ stage, layout, verifier }) => {
      const { parent, prefix, owner, lifetime } = await createRollbackFixture();
      const unrelated = openOpenClawStateDatabase({
        env: { OPENCLAW_STATE_DIR: path.join(parent, "unrelated") },
      });
      try {
        await withEnvAsync(
          {
            OPENCLAW_AGENT_DIR: path.join(parent, "previous-agent"),
            PI_CODING_AGENT_DIR: path.join(parent, "previous-legacy-agent"),
            OPENCLAW_ACQUISITION_EMPTY: "",
            OPENCLAW_ACQUISITION_ABSENT: undefined,
          },
          async () => {
            const keys = [
              "HOME",
              "USERPROFILE",
              "HOMEDRIVE",
              "HOMEPATH",
              "OPENCLAW_HOME",
              "OPENCLAW_STATE_DIR",
              "OPENCLAW_CONFIG_PATH",
              "OPENCLAW_AGENT_DIR",
              "PI_CODING_AGENT_DIR",
              "OPENCLAW_ACQUISITION_EMPTY",
              "OPENCLAW_ACQUISITION_ABSENT",
            ];
            const previous = readEnv(keys);
            const rollbackObservation = createDeferredCore<typeof previous>();
            const snapshot = captureEnv(keys);
            const fault = new Error(`failed ${stage} acquisition`);
            const mkdir = fs.mkdir;
            const writeFile = fs.writeFile;
            const set = Reflect.set;
            const cleanupSpy = vi.spyOn(sessionCleanup, "cleanupSessionStateForTest");
            const faultSpy =
              stage === "realpath"
                ? vi.spyOn(fs, "realpath").mockRejectedValueOnce(fault)
                : stage === "config"
                  ? vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
                      await writeFile(...args);
                      throw fault;
                    })
                  : stage === "environment"
                    ? vi.spyOn(Reflect, "set").mockImplementation((...args) => {
                        const result = set(...args);
                        const [target, key] = args;
                        if (target === process.env && key === "HOME") {
                          faultSpy.mockRestore();
                          // This runs at the first microtask boundary after the
                          // partial write; rollback must already have restored env.
                          queueMicrotask(() => rollbackObservation.resolve(readEnv(keys)));
                          throw fault;
                        }
                        return result;
                      })
                    : vi.spyOn(fs, "mkdir").mockImplementation(async (...args) => {
                        const result = await mkdir(...args);
                        if (path.basename(String(args[0])) === stage) {
                          throw fault;
                        }
                        return result;
                      });
            try {
              await expect(
                lifetime.run(() =>
                  createOpenClawTestState({
                    prefix,
                    layout,
                    scenario: "minimal",
                    applyEnv: stage !== "config",
                    verifyCleanup: verifier === "lifetime" ? lifetime.verifyCleanup : undefined,
                    env: {
                      OPENCLAW_ACQUISITION_EMPTY: "changed",
                      OPENCLAW_ACQUISITION_ABSENT: "added",
                    },
                  }),
                ),
              ).rejects.toBe(fault);
              if (stage === "environment") {
                expect(await rollbackObservation.promise).toEqual(previous);
              }
              await lifetime.cleanup();
              expect(() => owner.assertReleased()).not.toThrow();
              expectEnv(previous);
              expect((await fs.readdir(parent)).toSorted()).toEqual([
                ".vitest-resource-owner",
                "unrelated",
              ]);
              expect(unrelated.db.isOpen).toBe(true);
              expect(cleanupSpy).not.toHaveBeenCalled();
              faultSpy.mockRestore();

              const recovered = await createOpenClawTestState({
                prefix,
                layout: "split",
                scenario: "minimal",
                applyEnv: false,
              });
              try {
                expectEnv(previous);
                expect(recovered.configPath).toBe(
                  path.join(recovered.root, "config", "openclaw.json"),
                );
                expect(JSON.parse(await fs.readFile(recovered.configPath, "utf8"))).toEqual({});
                recovered.applyEnv();
                expect(process.env.HOME).toBe(recovered.home);
                expect(process.env.OPENCLAW_STATE_DIR).toBe(recovered.stateDir);
              } finally {
                await recovered.cleanup();
              }
              await recovered.cleanup();
              expectEnv(previous);
              expect((await fs.readdir(parent)).toSorted()).toEqual([
                ".vitest-resource-owner",
                "unrelated",
              ]);
              expect(unrelated.db.isOpen).toBe(true);
            } finally {
              faultSpy.mockRestore();
              cleanupSpy.mockRestore();
              snapshot.restore();
              await lifetime.cleanup();
            }
          },
        );
      } finally {
        closeOpenClawStateDatabaseByPath(unrelated.path);
        await fs.rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("restores late env additions before the next fixture", async () => {
    const previous = {
      OPENCLAW_TEST_LATE_ABSENT: undefined,
      OPENCLAW_TEST_LATE_EMPTY: "",
      OPENCLAW_TEST_LATE_PRESENT: "original",
    };
    await withEnvAsync(previous, async () => {
      const state = await createOpenClawTestState({ label: "late-env" });
      try {
        const first = {
          OPENCLAW_TEST_LATE_ABSENT: "first",
          OPENCLAW_TEST_LATE_EMPTY: "first",
          OPENCLAW_TEST_LATE_PRESENT: undefined,
        };
        Object.assign(state.envVars, first);
        state.applyEnv();
        expectEnv(first);
        for (const key of Object.keys(previous)) {
          state.envVars[key] = "second";
        }
        state.applyEnv();
        for (const key of Object.keys(previous)) {
          expect(process.env[key]).toBe("second");
        }
      } finally {
        await state.cleanup();
      }
      await state.cleanup();
      await withOpenClawTestState({ label: "after-late-env" }, async (next) => {
        expectEnv(previous);
        expectEnv(previous, next.env);
      });
    });
  });

  it.each([
    { agentEnv: undefined, applyEnv: true },
    { agentEnv: undefined, applyEnv: false },
    { agentEnv: "main", applyEnv: true },
  ] as const)(
    "isolates inherited agent selectors with $agentEnv and applyEnv=$applyEnv",
    async ({ agentEnv, applyEnv }) => {
      const inherited = {
        OPENCLAW_AGENT_DIR: "/tmp/outside-openclaw-agent",
        PI_CODING_AGENT_DIR: "/tmp/outside-legacy-agent",
      };
      await withEnvAsync(inherited, async () => {
        await withOpenClawTestState(
          {
            layout: agentEnv === "main" ? "home" : "state-only",
            agentEnv,
            applyEnv,
          },
          async (state) => {
            const expectedAgentDir = agentEnv === "main" ? state.agentDir() : undefined;
            const selectors = {
              OPENCLAW_AGENT_DIR: expectedAgentDir,
              PI_CODING_AGENT_DIR: undefined,
            };
            expectEnv(selectors, state.env);
            expectEnv(applyEnv ? selectors : inherited);
            expect(state.agentDir()).toBe(path.join(state.stateDir, "agents", "main", "agent"));
          },
        );
        expectEnv(inherited);
      });
    },
  );

  it("allows explicit agent-dir overrides over main selection and restores absent or empty selectors", async () => {
    const previous = { OPENCLAW_AGENT_DIR: undefined, PI_CODING_AGENT_DIR: "" };
    await withEnvAsync(previous, async () => {
      const overrides = {
        OPENCLAW_AGENT_DIR: "/tmp/explicit-openclaw-agent",
        PI_CODING_AGENT_DIR: "/tmp/explicit-legacy-agent",
      };
      await withOpenClawTestState(
        {
          agentEnv: "main",
          applyEnv: false,
          env: overrides,
        },
        async (state) => {
          expectEnv(overrides, state.env);
          expectEnv(previous);
          state.applyEnv();
          expectEnv(overrides);
        },
      );
      expectEnv(previous);
    });
  });

  it("writes scenario configs and auth profile stores", async () => {
    await withOpenClawTestState({ scenario: "update-stable" }, async (state) => {
      expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual({
        update: { channel: "stable" },
        plugins: {},
      });
      const profilePath = await state.writeAuthProfiles(makeAuthStore());
      expect(profilePath).toBe(path.join(state.agentDir(), "openclaw-agent.sqlite"));
      expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
        version: 1,
        profiles: { "openai:test": { provider: "openai" } },
      });
    });
  });

  it.each(["state", "configured"])(
    "closes only fixture-owned %s databases before restoring env",
    async (location) => {
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      const unrelatedRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-test-state-unrelated-"),
      );
      const unrelatedEnv = {
        ...process.env,
        OPENCLAW_STATE_DIR: path.join(unrelatedRoot, "state"),
      };
      const state = await createOpenClawTestState({
        layout: "state-only",
        label: "database-cleanup",
      });
      const fixtureAuthDir =
        location === "configured" ? state.path("configured-auth") : state.agentDir("auth-reader");
      const fixtureAuthPath = resolveAuthProfileDatabasePath(fixtureAuthDir);
      saveAuthFixture(fixtureAuthDir);
      const unrelatedAgentDir = path.join(unrelatedRoot, "state", "agents", "outside", "agent");
      saveAuthFixture(unrelatedAgentDir);
      const fixtureShared = openOpenClawStateDatabase({ env: state.env });
      const fixtureAgent = openOpenClawAgentDatabase({
        agentId: "worker",
        env: state.env,
        path:
          location === "configured" ? state.path("configured", "openclaw-agent.sqlite") : undefined,
      });
      const unrelatedShared = openOpenClawStateDatabase({ env: unrelatedEnv });
      const unrelatedAgent = openOpenClawAgentDatabase({
        agentId: "outside",
        env: unrelatedEnv,
      });
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const loadReader = (dir: string, expectedPath: string) => {
        expect(loadPersistedAuthProfileStore(dir)).not.toBeNull();
        const result = openSpy.mock.results.find((_, index) => {
          const call = openSpy.mock.calls[index];
          return (
            call?.[1]?.readOnly === true && path.resolve(call[0]) === path.resolve(expectedPath)
          );
        });
        if (result?.type !== "return") {
          throw new Error("expected pooled auth reader");
        }
        return result.value;
      };
      const fixtureAuthReader = loadReader(fixtureAuthDir, fixtureAuthPath);
      const unrelatedAuthReader = loadReader(unrelatedAgentDir, unrelatedAgent.path);
      expectOpen(true, fixtureAuthReader, unrelatedAuthReader);
      const expectFixtureClosed = () => {
        expectOpen(false, fixtureAuthReader, fixtureAgent.db);
        expect(
          openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(fixtureShared.path),
        ).toBeUndefined();
      };
      const expectUnrelatedOpen = () =>
        expectOpen(true, unrelatedAuthReader, unrelatedShared.db, unrelatedAgent.db);
      const restoreEnv = state.restoreEnv;
      const originalRm = fs.rm;
      const rmSpy = vi.spyOn(fs, "rm").mockImplementation((...args) => {
        expectFixtureClosed();
        expectOpen(true, unrelatedAuthReader);
        return originalRm(...args);
      });
      state.restoreEnv = async () => {
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        await restoreEnv();
        expectFixtureClosed();
        expectOpen(false, fixtureShared.db);
        expectUnrelatedOpen();
      };

      try {
        await state.cleanup();

        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        expect(rmSpy).toHaveBeenCalledWith(state.root, removeOptions);
        await expectPathMissing(state.root);
        expectUnrelatedOpen();
      } finally {
        state.restoreEnv = restoreEnv;
        await restoreEnv();
        for (const databasePath of [fixtureAuthPath, unrelatedAgent.path]) {
          closeAuthProfileReadPool({ kind: "database", databasePath });
        }
        for (const databasePath of [fixtureAuthPath, fixtureAgent.path, unrelatedAgent.path]) {
          closeOpenClawAgentDatabaseByPath(databasePath);
        }
        for (const database of [fixtureShared, unrelatedShared]) {
          closeOpenClawStateDatabaseByPath(database.path);
        }
        openSpy.mockRestore();
        rmSpy.mockRestore();
        await fs.rm(state.root, removeOptions);
        await fs.rm(unrelatedRoot, removeOptions);
      }
    },
  );

  it.each(["state", "configured"])(
    "does not recreate %s fixture databases from a deferred transcript reconcile",
    async (location) => {
      const state = await createOpenClawTestState({ label: "deferred-reconcile" });
      const options = {
        agentId: "main",
        env: state.env,
        path:
          location === "configured" ? state.path("configured", "openclaw-agent.sqlite") : undefined,
      };
      const agent = openOpenClawAgentDatabase(options);
      const shared = openOpenClawStateDatabase({ env: state.env });
      const resumeReconcile = createDeferredCore();
      const runOperation = reconcilePool.runSessionTranscriptReconcileOperation;
      const operationSpy = vi
        .spyOn(reconcilePool, "runSessionTranscriptReconcileOperation")
        .mockImplementationOnce((run, owner) =>
          runOperation(async (operation) => {
            await resumeReconcile.promise;
            return run(operation);
          }, owner),
        );
      const rmSpy = vi.spyOn(fs, "rm");
      const openSpy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let cleanup: Promise<void> | undefined;
      let reconcile: Promise<void> | undefined;
      try {
        startSessionTranscriptIndexReconcile(options);
        reconcile = waitForSessionTranscriptIndexReconcile(options);
        expect(isSessionTranscriptIndexReconcileRunning(options)).toBe(true);
        cleanup = state.cleanup();

        // Empty drains settle before this real event-loop checkpoint. Old cleanup
        // reaches rm; repaired cleanup must keep the fixture alive for the owner.
        await nextTurn();
        expect(rmSpy.mock.calls.some(([target]) => target === state.root)).toBe(false);
        expect(agent.db.isOpen).toBe(true);
        expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
        resumeReconcile.resolve();
        await reconcile;
        await cleanup;

        for (const target of [state.root, agent.path, shared.path]) {
          await expectPathMissing(target);
        }
        expect(isOpenClawAgentDatabaseOpen(agent.path)).toBe(false);
        expectOpen(false, agent.db, shared.db);
        expect(openSpy.mock.calls.filter(([pathname]) => pathname === agent.path)).toEqual([]);
      } finally {
        operationSpy.mockRestore();
        resumeReconcile.resolve();
        await reconcile;
        // A failing implementation can reach removal with a configured handle
        // still open. Release it after its reconcile joins, before joining rm.
        closeOpenClawAgentDatabaseByPath(agent.path);
        closeOpenClawStateDatabaseByPath(shared.path);
        await cleanup;
        await state.cleanup();
        openSpy.mockRestore();
        rmSpy.mockRestore();
        await fs.rm(state.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["ordinary", "indeterminate", "caught indeterminate"] as const)(
    "preserves %s callback failures after closing fixture databases",
    async (failure) => {
      const callbackError = Object.assign(
        new Error("fixture callback failed"),
        failure === "ordinary" ? {} : { processTreeState: "indeterminate" },
      );
      const selectorKeys = ["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"];
      const environment = captureEnv(selectorKeys);
      const previous = selectorKeys.map((key) => process.env[key]);
      let root = "";
      let runtimePath = "";
      let shared: ReturnType<typeof openOpenClawStateDatabase> | undefined;
      let agent: ReturnType<typeof openOpenClawAgentDatabase> | undefined;

      try {
        await expect(
          withOpenClawTestState({ label: "callback-failure" }, async (state) => {
            root = state.root;
            runtimePath = await state.writeText(
              "runtime/entry.mjs",
              "export const fixture = true;\n",
            );
            shared = openOpenClawStateDatabase({ env: state.env });
            agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
            if (failure === "caught indeterminate") {
              await trackAsyncWork(async () => {
                throw callbackError;
              }).catch(() => undefined);
              return;
            }
            throw callbackError;
          }),
        ).rejects.toBe(callbackError);

        expect({ shared, agent }).toMatchObject({
          shared: { db: { isOpen: false } },
          agent: { db: { isOpen: false } },
        });
        expect(selectorKeys.map((key) => process.env[key])).toEqual(previous);
        if (failure === "ordinary") {
          await expectPathMissing(root);
        } else {
          expect(await fs.readFile(runtimePath, "utf8")).toBe("export const fixture = true;\n");
        }
      } finally {
        environment.restore();
        if (agent) {
          closeOpenClawAgentDatabaseByPath(agent.path);
        }
        if (shared) {
          closeOpenClawStateDatabaseByPath(shared.path);
        }
        // This synthetic failure owns no native child; dispose only its retained test inputs.
        if (root) {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    },
  );

  it("creates upgrade survivor fixture state", async () => {
    await withOpenClawTestState({ scenario: "upgrade-survivor" }, async (state) => {
      const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(config.update?.channel).toBe("stable");
      expect(config.plugins?.enabled).toBe(true);
      expect(config.plugins?.allow).toStrictEqual(["discord", "telegram", "whatsapp", "memory"]);
    });
  });

  it("keeps external-service env scoped to the fixture", async () => {
    const previousPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;

    await withOpenClawTestState({ scenario: "external-service" }, async (state) => {
      expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
      expect(state.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");
    });

    expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe(previousPolicy);
  });
});
