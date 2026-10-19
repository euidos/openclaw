import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { loadSessionEntry } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { SessionEntryMaintenancePlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { kickSessionEntryMaintenanceAfterWrite } from "./session-accessor.sqlite-maintenance-kick.js";
import * as maintenance from "./session-accessor.sqlite-maintenance.js";
import {
  createSessionMaintenanceKickStore,
  observeSessionMaintenancePlanningWorker,
} from "./session-accessor.sqlite-maintenance.test-support.js";
import * as reclamationRun from "./session-accessor.sqlite-reclamation-run.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:age-kick";

function observeMaintenanceCompletion(databasePath: string) {
  const completed = createDeferred();
  const release = maintenance.releaseSessionEntryMaintenanceExecution;
  const observer = vi
    .spyOn(maintenance, "releaseSessionEntryMaintenanceExecution")
    .mockImplementation((pathname, owner) => {
      release(pathname, owner);
      if (pathname === databasePath && owner.release) {
        void owner.release.then(completed.resolve, completed.reject);
      }
    });
  return (signal: AbortSignal) =>
    withinTest(completed.promise, signal).finally(() => observer.mockRestore());
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

function createCapBatchStore(afterPlan?: () => void | Promise<void>) {
  const fixture = createSessionMaintenanceKickStore({
    storePath: path.join(tempDirs.make("session-maintenance-cap-"), "agent.sqlite"),
    key: sessionKey,
    pruneAfterMs: 86_400_000,
    workerMaintenance: true,
    maintenanceScopes: [],
  });
  fixture.request.maintenanceConfig.maxEntries = 100;
  vi.useRealTimers();
  const keys = Array.from({ length: 179 }, (_, index) => `agent:main:cap-batch-${index}`);
  runOpenClawAgentWriteTransaction((database) => {
    keys.forEach((key, index) => {
      writeSessionEntry(database, key, {
        sessionId: `cap-batch-${index}`,
        updatedAt: fixture.updatedAt - keys.length + index,
      });
    });
  }, fixture.scope);
  const plans: SessionEntryMaintenancePlan[] = [];
  const dispatch = vi.mocked(reclamationRun.runSqliteSessionReclamation);
  const run = dispatch.getMockImplementation()!;
  dispatch.mockImplementation(async (params) => {
    const result = await run(params);
    if (result.kind === "maintenance-plan") {
      plans.push(result.value);
      await afterPlan?.();
    }
    return result;
  });
  return {
    ...fixture,
    keys,
    plans,
    archivedKeys: () =>
      keys.filter(
        (key) => loadSessionEntry({ storePath: fixture.storePath, sessionKey: key })?.archivedAt,
      ),
  };
}

it("releases the cap writer between batches and honors new protection", async ({ signal }) => {
  let protectedKeys: string[] = [];
  let releases = 0;
  let foreground: Promise<unknown> | undefined;
  const batch = createCapBatchStore(async () => {
    if (++releases === 1) {
      protectedKeys = [keys[64]!];
      await withinTest(foreground!, signal);
    }
  });
  const { request, storePath, keys, plans } = batch;
  const protectedKey = keys[64]!;
  const unregister = registerSessionMaintenancePreserveKeysProvider(async () => ({
    capture: () => protectedKeys,
    dispose() {},
  }));
  let commits = 0;
  let foregroundCompleted = false;
  observeSessionMaintenancePlanningWorker({
    afterExecute(result) {
      if (result.kind === "committed" && ++commits === 1) {
        // Queue under the first operation; await only after its FIFO custody is released.
        foreground = patchSessionEntryCore(
          { storePath, sessionKey },
          () => ({ label: "foreground between cap batches" }),
          { skipMaintenance: true },
        ).then(() => {
          foregroundCompleted = true;
        });
      }
    },
    beforeExecute() {
      if (commits > 0) {
        expect(foregroundCompleted).toBe(true);
      }
    },
  });
  try {
    const completed = observeMaintenanceCompletion(storePath);
    kickSessionEntryMaintenanceAfterWrite(request);
    await completed(signal);
    expect(plans.map((plan) => plan.capArchived).filter(Boolean)).toEqual([64, 16]);
    expect(loadSessionEntry({ storePath, sessionKey })?.label).toBe(
      "foreground between cap batches",
    );
    expect(loadSessionEntry({ storePath, sessionKey: protectedKey })?.archivedAt).toBeUndefined();
    const archived = batch.archivedKeys();
    expect(archived).toEqual(keys.slice(0, 81).filter((key) => key !== protectedKey));
    expect(loadSessionEntry({ storePath, sessionKey })?.archivedAt).toBeUndefined();
    expect(plans.flatMap((plan) => plan.archivedEntries.map((entry) => entry.sessionKey))).toEqual(
      archived,
    );
  } finally {
    unregister();
  }
});

it("keeps the first cap receipt and stops later batches when maintenance authority retires", async ({
  signal,
}) => {
  const retired = createDeferred();
  let releases = 0;
  const { database, request, keys, plans, archivedKeys } = createCapBatchStore(() => {
    if (++releases === 1) {
      markGatewayRestartDraining();
      retired.resolve();
    }
  });
  kickSessionEntryMaintenanceAfterWrite(request);
  await withinTest(retired.promise, signal);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  expect(plans.map((plan) => plan.capArchived)).toEqual([64]);
  expect(archivedKeys()).toEqual(keys.slice(0, 64));
});
