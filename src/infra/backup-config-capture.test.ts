import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import * as backupShared from "../commands/backup-shared.js";
import { prepareBackupArchive, verifyBackupArchive } from "../commands/backup-verify.js";
import { createConfigIO } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries, useIsolatedBackupTempRoot } from "./backup-create.test-support.js";
import * as sqliteCapture from "./backup-sqlite-snapshot.js";
import { requireNodeSqlite, resolveSqliteFilesystemPath } from "./node-sqlite.js";

const runtime: RuntimeEnv = { log: () => {}, error: () => {}, exit: () => {} };
useIsolatedBackupTempRoot();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function configGraph(state: OpenClawTestState) {
  vi.stubEnv("BACKUP_INCLUDE_PLACEHOLDER", "synthetic-placeholder-value");
  const configDir = path.dirname(state.configPath);
  const includePath = path.join(configDir, "parts", "settings.json5");
  const leafPath = path.join(configDir, "parts", "leaf.json5");
  const root = `// authored root\n{ "$include": "./parts/settings.json5", agents: { ownership: "explicit", entries: { main: {} } } }\n`;
  const include = `{ "$include": "./leaf.json5" }\n`;
  const leaf = `// keep comments and placeholders\n{ gateway: { mode: "local", auth: { mode: "token", token: "\${BACKUP_INCLUDE_PLACEHOLDER}" } } }\n`;
  await fs.mkdir(path.dirname(includePath), { recursive: true });
  const files = new Map([
    [state.configPath, root],
    [includePath, include],
    [leafPath, leaf],
  ]);
  for (const [file, raw] of files) {
    await fs.writeFile(file, raw);
  }
  const snapshot = await createConfigIO({ observe: false }).readConfigFileSnapshot();
  expect(snapshot.issues).toEqual([]);
  return { leafPath, files };
}

async function restore(state: OpenClawTestState, output: string, includeWorkspace = true) {
  const archive = await createBackupArchive({ output, includeWorkspace });
  await verifyBackupArchive(output);
  const restored = await backupRestoreCommand(runtime, {
    archive: output,
    target: state.path("restored"),
  });
  const restoredPath = (source: string) =>
    path.join(
      restored.targetPath,
      backupShared.buildBackupArchivePath(archive.archiveRoot, source),
    );
  return { archive, restoredPath };
}

async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectText(file: string, text: string | undefined) {
  expect(await fs.readFile(file, "utf8")).toBe(text);
}

async function expectRefused(state: OpenClawTestState) {
  const output = state.path("refused.tar.gz");
  await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toThrow(
    /required config file .*retry backup/s,
  );
  await expectMissing(output);
}

function afterDiscovery(run: () => Promise<void>) {
  const resolve = backupShared.resolveBackupPlanFromDisk;
  vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockImplementationOnce(async (options) => {
    const plan = await resolve(options);
    await run();
    return plan;
  });
}

function beforeDatabaseCapture(run: () => Promise<void>) {
  const capture = sqliteCapture.createBackupSqliteSnapshotPlan;
  vi.spyOn(sqliteCapture, "createBackupSqliteSnapshotPlan").mockImplementationOnce(
    async (params) => {
      await run();
      return capture(params);
    },
  );
}

describe("full backup config include capture", () => {
  it.each([
    { name: "external config", layout: "split", rootLink: false, invalid: false },
    { name: "in-state config", layout: "state-only", rootLink: false, invalid: false },
    { name: "root link", layout: "state-only", rootLink: true, invalid: false },
    { name: "schema-invalid config", layout: "split", rootLink: false, invalid: true },
  ] as const)(
    "restores a raw nested graph through $name without the original includes",
    async ({ layout, rootLink, invalid }) => {
      await withOpenClawTestState({ layout }, async (state) => {
        vi.stubEnv("BACKUP_INCLUDE_PLACEHOLDER", "must-not-be-expanded");
        const { files } = await configGraph(state);
        if (invalid) {
          const raw = files
            .get(state.configPath)!
            .replace('ownership: "explicit"', "defaults: { workspace: 42 }");
          await fs.writeFile(state.configPath, raw);
          await expect(
            createBackupArchive({ output: state.path("backup.tar.gz"), includeWorkspace: false }),
          ).rejects.toThrow(/ownership could not be resolved/i);
          return;
        }
        if (rootLink) {
          const authoredRoot = state.path("authored-config.json5");
          await fs.rename(state.configPath, authoredRoot);
          await fs.symlink(authoredRoot, state.configPath);
        }
        await fs.writeFile(state.statePath("ordinary.txt"), "ordinary");
        const { archive, restoredPath } = await restore(state, state.path("backup.tar.gz"));
        expect((await prepareBackupArchive(archive.archivePath)).recoveryConfigPath).toBe(
          backupShared.buildBackupArchivePath(
            archive.archiveRoot,
            await fs.realpath(state.configPath),
          ),
        );
        const entries = await listArchiveEntries(archive.archivePath);
        expect(new Set(entries).size).toBe(entries.length);
        for (const [source, raw] of files) {
          await expectText(restoredPath(source), raw);
        }
        await expectText(restoredPath(state.statePath("ordinary.txt")), "ordinary");
        // Remove only this fixture's source lookup, so parsing cannot succeed by
        // accidentally reading the originals instead of the restored graph.
        await fs.rename(
          path.join(path.dirname(state.configPath), "parts"),
          state.path("original-parts"),
        );
        const snapshot = await createConfigIO({
          configPath: restoredPath(state.configPath),
          observe: false,
        }).readConfigFileSnapshot();
        expect(snapshot).toMatchObject({
          valid: true,
          issues: [],
          config: { gateway: { mode: "local" } },
        });
        expect(snapshot.includeProvenance).toBeDefined();
        expect(archive.skipped.some(({ reason }) => reason === "unresolved")).toBe(false);
      });
    },
  );

  it("keeps required workspace includes but leaves only-config root-only", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const workspace = state.statePath("workspace");
      await fs.mkdir(workspace);
      const leaf = path.join(workspace, "required.json5");
      await fs.writeFile(leaf, '{ gateway: { mode: "local" } }');
      await fs.writeFile(path.join(workspace, "workspace-only.txt"), "omit");
      await state.writeConfig({
        $include: "./workspace/required.json5",
        agents: { defaults: { workspace }, entries: { main: {} } },
      });
      const { restoredPath } = await restore(state, state.path("full.tar.gz"), false);
      expect(await fs.readFile(restoredPath(leaf), "utf8")).toContain('mode: "local"');
      await expect(
        fs.stat(restoredPath(path.join(workspace, "workspace-only.txt"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const rootOnly = await createBackupArchive({
        output: state.path("root.tar.gz"),
        onlyConfig: true,
      });
      await verifyBackupArchive(rootOnly.archivePath);
      const entries = await listArchiveEntries(rootOnly.archivePath);
      expect(entries).toEqual(
        expect.arrayContaining([
          backupShared.buildBackupArchivePath(rootOnly.archiveRoot, state.configPath),
        ]),
      );
      expect(entries.some((entry) => entry.endsWith("required.json5"))).toBe(false);
    });
  });

  it.each(["missing", "alias"])(
    "refuses an indeterminate %s graph before publication",
    async (kind) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const { leafPath } = await configGraph(state);
        if (kind === "missing") {
          await fs.unlink(leafPath);
        }
        if (kind === "alias") {
          const moved = path.join(path.dirname(state.configPath), "real-parts");
          await fs.rename(path.dirname(leafPath), moved);
          await fs.symlink(
            moved,
            path.dirname(leafPath),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        await expectRefused(state);
        // Even an unresolved graph can still be exported explicitly as root-only.
        const rootOnly = await createBackupArchive({
          output: state.path("root-only.tar.gz"),
          onlyConfig: true,
        });
        await verifyBackupArchive(rootOnly.archivePath);
      });
    },
  );

  it.each(["leaf", "replacement", "unreadable"])(
    "refuses %s changes after discovery without overwriting sources",
    async (kind) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const { leafPath, files } = await configGraph(state);
        afterDiscovery(async () => {
          if (kind === "leaf") {
            const stat = await fs.stat(leafPath);
            await fs.writeFile(leafPath, files.get(leafPath)!.replace("local", "other"));
            await fs.utimes(leafPath, stat.atime, stat.mtime);
          } else if (kind === "replacement") {
            await fs.rename(leafPath, `${leafPath}.original`);
            await fs.writeFile(leafPath, files.get(leafPath)!);
          } else {
            const open = fs.open;
            vi.spyOn(fs, "open").mockImplementation(async (...args) => {
              if (args[0] === leafPath) {
                throw Object.assign(new Error("denied"), { code: "EACCES" });
              }
              return open(...args);
            });
          }
        });
        await expectRefused(state);
        if (kind === "leaf") {
          expect(await fs.readFile(leafPath, "utf8")).toContain('mode: "other"');
        }
        if (kind === "replacement") {
          await expectText(`${leafPath}.original`, files.get(leafPath));
        }
      });
    },
  );

  it("uses sealed config even if sources change before database capture and tar traversal", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const { leafPath, files } = await configGraph(state);
      const { DatabaseSync } = requireNodeSqlite();
      const dbPath = resolveOpenClawStateSqlitePath(state.env);
      openOpenClawStateDatabase({ env: state.env });
      closeOpenClawStateDatabase();
      const db = new DatabaseSync(dbPath);
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('captured');",
      );
      expect((await fs.stat(`${dbPath}-wal`)).size).toBeGreaterThan(0);
      const snapshotSqlite = sqliteCapture.createBackupSqliteSnapshotPlan;
      vi.spyOn(sqliteCapture, "createBackupSqliteSnapshotPlan").mockImplementationOnce(
        async (params) => {
          const snapshot = await snapshotSqlite(params);
          await fs.writeFile(leafPath, '{ gateway: { mode: "remote" } }');
          db.exec("INSERT INTO proof VALUES ('later')");
          return snapshot;
        },
      );
      try {
        const { restoredPath } = await restore(state, state.path("backup.tar.gz"));
        expect(db.prepare("SELECT value FROM proof").all()).toEqual([
          { value: "captured" },
          { value: "later" },
        ]);
        const copy = new DatabaseSync(resolveSqliteFilesystemPath(restoredPath(dbPath)), {
          readOnly: true,
        });
        try {
          expect(copy.prepare("SELECT value FROM proof").all()).toEqual([{ value: "captured" }]);
        } finally {
          copy.close();
        }
        expect(await fs.readFile(leafPath, "utf8")).toContain('mode: "remote"');
        await expectText(restoredPath(leafPath), files.get(leafPath));
      } finally {
        db.close();
      }
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a config replaced by a FIFO at open without dispatching a blocking read",
    async () => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const { leafPath, files } = await configGraph(state);
        let replaced = false;
        let blockingOpen = false;
        afterDiscovery(async () => {
          const open = fs.open;
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            if (!replaced && args[0] === leafPath) {
              replaced = true;
              await fs.rename(leafPath, `${leafPath}.original`);
              execFileSync("mkfifo", [leafPath]);
              const flags = args[1];
              if (typeof flags !== "number" || !(flags & fsSync.constants.O_NONBLOCK)) {
                blockingOpen = true;
                throw new Error("refusing a blocking FIFO open in the test");
              }
            }
            return open(...args);
          });
        });
        await expectRefused(state);
        expect(replaced).toBe(true);
        expect(blockingOpen).toBe(false);
        await expectText(`${leafPath}.original`, files.get(leafPath));
      });
    },
  );

  it.each(["present", "missing"])(
    "does not archive a later include-bearing root that was %s without includes at capture",
    async (initial) => {
      await withOpenClawTestState(
        { layout: initial === "present" ? "split" : "state-only" },
        async (state) => {
          const { files } = await configGraph(state);
          const plain = "{ agents: { entries: { main: {} } } }\n";
          if (initial === "present") {
            await fs.writeFile(state.configPath, plain);
          } else {
            await fs.unlink(state.configPath);
          }
          beforeDatabaseCapture(() => fs.writeFile(state.configPath, files.get(state.configPath)!));
          const { restoredPath } = await restore(state, state.path("plain.tar.gz"));
          await expectText(state.configPath, files.get(state.configPath));
          if (initial === "present") {
            await expectText(restoredPath(state.configPath), plain);
          } else {
            await expectMissing(restoredPath(state.configPath));
          }
        },
      );
    },
  );

  it("refuses a root alias retargeted after sealing and cleans the unpublished archive", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const first = state.statePath("first.json");
      const second = state.statePath("second.json");
      await fs.writeFile(first, "{}");
      await fs.writeFile(second, "{}");
      await fs.symlink(first, state.configPath);
      beforeDatabaseCapture(async () => {
        await fs.unlink(state.configPath);
        await fs.symlink(second, state.configPath);
      });
      const output = state.path("retargeted.tar.gz");
      await expect(createBackupArchive({ output })).rejects.toThrow(/config alias changed/);
      await expectMissing(output);
      expect(await fs.realpath(state.configPath)).toBe(second);
      expect(
        (await fs.readdir(state.root)).filter((name) => name.startsWith(".openclaw-backup-")),
      ).toEqual([]);
    });
  });

  it("preserves staging ENOSPC and leaves no published archive", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const { files } = await configGraph(state);
      const write = fs.writeFile;
      const diskFull = Object.assign(new Error("synthetic staging disk full"), { code: "ENOSPC" });
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && /config-\d+$/.test(args[0])) {
          throw diskFull;
        }
        return write(...args);
      });
      const output = state.path("refused.tar.gz");
      await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toBe(diskFull);
      await expectMissing(output);
      for (const [source, raw] of files) {
        await expectText(source, raw);
      }
    });
  });
});
