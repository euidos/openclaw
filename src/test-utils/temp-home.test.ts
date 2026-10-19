import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import { resolveEffectiveHomeDir } from "../infra/home-dir.js";
import { withTempHomeCore } from "../plugin-sdk/test-helpers/temp-home.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import * as stateCache from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureFullEnv } from "./env.js";
import { createTempHomeEnv } from "./temp-home.js";

const homeKeys = "HOME USERPROFILE HOMEDRIVE HOMEPATH OPENCLAW_HOME OPENCLAW_STATE_DIR".split(" ");
const readEnv = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const setEnv = (values: NodeJS.ProcessEnv) => {
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value);
  }
};
let sandbox: string;
let prefix: string;
let snapshot: ReturnType<typeof captureFullEnv>;

beforeEach(async () => {
  snapshot = captureFullEnv();
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "home-acquisition-")));
  prefix = path.join(path.basename(sandbox), "home-");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  snapshot.restore();
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("createTempHomeEnv", () => {
  it.each(["shared", "plugin-sdk"] as const)(
    "closes configured databases before removing %s home",
    async (fixtureKind) => {
      let home = "";
      let database: ReturnType<typeof agentDb.openOpenClawAgentDatabase> | undefined;
      let databaseOpenAtRemoval: boolean | undefined;
      const remove = fs.rm;
      vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (home && path.resolve(String(target)) === path.resolve(home)) {
          databaseOpenAtRemoval = database?.db.isOpen;
          return;
        }
        await remove(target, options);
      });
      const openConfiguredDatabase = (fixtureHome: string) => {
        home = fixtureHome;
        database = agentDb.openOpenClawAgentDatabase({
          agentId: "main",
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") },
          path: path.join(home, "configured-sessions.sqlite"),
        });
      };
      if (fixtureKind === "shared") {
        const temporary = await createTempHomeEnv(prefix);
        openConfiguredDatabase(temporary.home);
        await temporary.restore();
      } else {
        await withTempHomeCore(async (fixtureHome) => openConfiguredDatabase(fixtureHome), {
          prefix,
        });
      }
      expect([databaseOpenAtRemoval, database?.db.isOpen]).toEqual([false, false]);
    },
  );

  it("restores env but retains home when drainage fails", async () => {
    const previous = readEnv(homeKeys);
    const temporary = await createTempHomeEnv(prefix);
    const stateDir = path.join(temporary.home, ".openclaw");
    const databasePath = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
    const admission = stateCache.captureOpenClawStateDatabaseReadAdmission(databasePath);
    const failure = new Error("fixture resource still owns its state");
    let rejectClose = true;
    const unregister = stateCache.registerOpenClawStateDatabaseAsyncResource({
      close: async (identity) => {
        if (identity?.key === admission.identity.key && rejectClose) {
          throw failure;
        }
      },
    });
    const marker = path.join(temporary.home, "owned.txt");
    try {
      await fs.writeFile(marker, "retained fixture");
      await expect(temporary.restore()).rejects.toBe(failure);
      expect(readEnv(homeKeys)).toEqual(previous);
      expect(await fs.readFile(marker, "utf8")).toBe("retained fixture");
    } finally {
      rejectClose = false;
      await stateCache.closeOpenClawStateDatabaseByPathAsync(databasePath);
      unregister();
      await temporary.restore();
    }
    expect(await fs.readdir(sandbox)).toEqual([]);
  });

  it.each(["directory", "environment"])(
    "rolls back %s failure while preserving sibling home",
    async (stage) => {
      const parent = sandbox;
      const sibling = await createTempHomeEnv(prefix);
      const siblingEntries = await fs.readdir(parent);
      const marker = path.join(sibling.home, "keep.txt");
      await fs.writeFile(marker, "sibling");
      try {
        const keys = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "OPENCLAW_STATE_DIR"];
        setEnv({ USERPROFILE: undefined, OPENCLAW_STATE_DIR: "" });
        const previous = readEnv(keys);
        const fault = new Error(`failed ${stage} acquisition`);
        const mkdir = fs.mkdir;
        const set = Reflect.set;
        const faultSpy =
          stage === "directory"
            ? vi.spyOn(fs, "mkdir").mockImplementationOnce(async (...args) => {
                await mkdir(...args);
                throw fault;
              })
            : vi.spyOn(Reflect, "set").mockImplementation((...args) => {
                const result = set(...args);
                const [target, key] = args;
                if (target === process.env && key === "USERPROFILE") {
                  faultSpy.mockRestore();
                  throw fault;
                }
                return result;
              });
        await expect(createTempHomeEnv(prefix)).rejects.toBe(fault);
        expect(readEnv(keys)).toEqual(previous);
        expect(await fs.readdir(parent)).toEqual(siblingEntries);
        expect(await fs.readFile(marker, "utf8")).toBe("sibling");
        faultSpy.mockRestore();
        const recovered = await createTempHomeEnv(prefix);
        expect(recovered.home).not.toBe(sibling.home);
        await recovered.restore();
        expect(await fs.readdir(parent)).toEqual(siblingEntries);
      } finally {
        vi.restoreAllMocks();
        await sibling.restore();
      }
      expect(await fs.readdir(parent)).toEqual([]);
    },
  );

  it("isolates inherited home and restores env on cleanup", async () => {
    const callerHome = path.join(os.tmpdir(), "caller-home");
    setEnv({ OPENCLAW_HOME: callerHome });
    const keys = ["HOME", "USERPROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_HOME"];
    const previous = readEnv(keys);
    const previousEffectiveHome = resolveEffectiveHomeDir();
    const tempHome = await createTempHomeEnv(prefix);
    try {
      expect(readEnv(keys.slice(0, 3))).toEqual({
        HOME: tempHome.home,
        USERPROFILE: tempHome.home,
        OPENCLAW_STATE_DIR: path.join(tempHome.home, ".openclaw"),
      });
      expect(resolveEffectiveHomeDir()).toBe(tempHome.home);
      const homeStat = await fs.stat(tempHome.home);
      expect(homeStat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        const stateStat = await fs.stat(path.join(tempHome.home, ".openclaw"));
        expect([homeStat.mode & 0o777, stateStat.mode & 0o777]).toEqual([0o700, 0o700]);
      }
    } finally {
      await tempHome.restore();
    }
    expect(readEnv(keys)).toEqual(previous);
    expect(resolveEffectiveHomeDir()).toBe(previousEffectiveHome);
    await expectPathMissing(tempHome.home);
    expect(await fs.readdir(sandbox)).toEqual([]);
  });
});

describe("withTempHome acquisition", () => {
  beforeEach(() => {
    vi.spyOn(os, "tmpdir").mockReturnValue(sandbox);
    prefix = `${path.basename(sandbox)}-`;
  });

  it.each(["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"])(
    "rejects reserved %s before allocation",
    async (key) => {
      const body = vi.fn(async () => undefined);
      await expect(withTempHomeCore(body, { prefix, env: { [key]: "invalid" } })).rejects.toThrow(
        `withTempHome: use built-in home env (got ${key})`,
      );
      expect(body).not.toHaveBeenCalled();
      expect(await fs.readdir(sandbox)).toEqual([]);
    },
  );

  it.each(["environment", "sessions"])(
    "rolls back failed %s acquisition before reuse",
    async (stage) => {
      const callerHome = path.join(sandbox, "caller");
      await fs.mkdir(callerHome);
      await fs.writeFile(path.join(callerHome, "keep"), "caller-owned");
      setEnv({
        OPENCLAW_HOME: callerHome,
        OPENCLAW_STATE_DIR: path.join(callerHome, ".openclaw"),
        ACQUISITION_ADDED: undefined,
        ACQUISITION_CHANGED: "",
        ACQUISITION_DELETED: "caller",
      });
      const callerEnv = { ...process.env };
      const failure = new Error(`${stage} acquisition failed`);
      const body = vi.fn(async () => undefined);
      let failedHome = "";
      const started = createDeferred();
      const release = createDeferred();
      const envReached = createDeferred();
      const failAcquisition = (home: string) => {
        failedHome = home;
        envReached.resolve();
        throw failure;
      };
      const mkdir = fs.mkdir;
      const fault =
        stage === "sessions"
          ? vi.spyOn(fs, "mkdir").mockImplementation(async (target, options) => {
              const result = await mkdir(target, options);
              if (path.basename(String(target)) === "sessions") {
                failAcquisition(path.resolve(String(target), "../../../.."));
              }
              return result;
            })
          : undefined;
      const writes: string[] = [];
      const storePath = path.join(callerHome, "sessions.json");
      const active = runExclusiveSessionStoreWrite(storePath, async () => {
        started.resolve();
        await release.promise;
        writes.push("active");
      });
      await started.promise;
      const pending = runExclusiveSessionStoreWrite(storePath, async () => {
        writes.push("pending");
      });
      const writers = Promise.allSettled([active, pending]);
      const env = {
        ACQUISITION_ADDED: "temporary",
        ACQUISITION_CHANGED: "temporary",
        ACQUISITION_DELETED: undefined,
        ACQUISITION_THROW: failAcquisition,
      };
      const acquisition = expect(
        withTempHomeCore(body, { prefix, skipHomeCleanup: stage === "environment", env }),
      ).rejects.toBe(failure);
      try {
        await Promise.race([envReached.promise, acquisition]);
      } finally {
        release.resolve();
        await writers;
        await acquisition;
        fault?.mockRestore();
      }
      expect(await writers).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(writes).toEqual(["active", "pending"]);
      expect(body).not.toHaveBeenCalled();
      expect.soft({ ...process.env }).toEqual(callerEnv);
      await expectPathMissing(failedHome);
      expect(await fs.readdir(sandbox)).toEqual([path.basename(callerHome)]);
      const result = await withTempHomeCore(
        async (home) => {
          expect(home).not.toBe(failedHome);
          expect(process.env.HOME).toBe(home);
          return "recovered";
        },
        { prefix },
      );
      expect(result).toBe("recovered");
      expect(process.env.HOME).toBe(callerEnv.HOME);
      expect(await fs.readFile(path.join(callerHome, "keep"), "utf8")).toBe("caller-owned");
      expect(await fs.readdir(sandbox)).toEqual([path.basename(callerHome)]);
    },
  );

  it.each([false, true])("respects body-failure retention=%s", async (skipHomeCleanup) => {
    const failure = new Error("body failed");
    const callerHome = process.env.HOME;
    let acquiredHome = "";
    const body = async (home: string) => {
      acquiredHome = home;
      await fs.writeFile(path.join(home, "retained"), "body artifact");
      throw failure;
    };
    const options = { prefix, skipHomeCleanup, skipSessionCleanup: true };
    await expect(withTempHomeCore(body, options)).rejects.toBe(failure);
    expect(process.env.HOME).toBe(callerHome);
    if (skipHomeCleanup) {
      expect(await fs.readFile(path.join(acquiredHome, "retained"), "utf8")).toBe("body artifact");
    } else {
      await expectPathMissing(acquiredHome);
    }
  });
});
