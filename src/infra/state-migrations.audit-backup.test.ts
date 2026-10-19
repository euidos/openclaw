import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  hasLegacyAuditBackupSources,
  isLegacyAuditMigrationBackupPath,
} from "./backup-audit-paths.js";
import { createLegacyAuditBackupCapture } from "./state-migrations.audit-backup.js";
import {
  buildAuditScrubbedContent,
  configAuditRecord,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";

const auditLine = (marker: string) => `${JSON.stringify(configAuditRecord(marker))}\n`;
const redacted = { argv: ["openclaw", "config", "set", "token", "***"] };
async function captureOne(stateDir: string, tempDir: string) {
  const { snapshots } = await createLegacyAuditBackupCapture({ stateDir, tempDir });
  expect(snapshots).toHaveLength(1);
  const asset = expectDefined(snapshots[0], "snapshot");
  return { asset, text: await fs.readFile(asset.sourcePath, "utf8") };
}

async function withBackupFixture(
  run: (fixture: {
    stateDir: string;
    tempDir: string;
    sourcePath: string;
    rawPath: string;
  }) => Promise<void>,
) {
  await withTestDir({ prefix: "openclaw-audit-backup-" }, async (rootDir) => {
    const stateDir = path.join(rootDir, "state");
    const tempDir = path.join(rootDir, "backup-temp");
    const sourcePath = path.join(stateDir, "logs", "config-audit.jsonl");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.mkdir(tempDir);
    await run({ stateDir, tempDir, sourcePath, rawPath: `${sourcePath}.migrated.raw` });
  });
}

describe("legacy audit raw backup snapshots", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it.each([
    ["logs/config-audit.jsonl", true],
    ["audit/.system-agent.jsonl.doctor-importing.2", true],
    ["logs/config-audit.jsonl.migrated.10.raw.doctor-scrub-progress", true],
    ["logs/config-audit.jsonl.migrated", false],
  ])(
    "keeps discovery and exclusion consistent for %s and its quarantines",
    async (relative, expected) => {
      await withTestDir({ prefix: "openclaw-audit-backup-family-" }, async (stateDir) => {
        let sourcePath = path.join(stateDir, relative);
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, "fixture");
        for (const suffix of ["", ".quarantined-2026-09-17", ".quarantined-retained-copy"]) {
          if (suffix) {
            await fs.rename(sourcePath, sourcePath + suffix);
            sourcePath += suffix;
          }
          expect(isLegacyAuditMigrationBackupPath(sourcePath, stateDir)).toBe(expected);
          await expect(hasLegacyAuditBackupSources(stateDir)).resolves.toBe(expected);
        }
      });
    },
  );

  it("rejects paths outside the audit state root", () => {
    expect(
      isLegacyAuditMigrationBackupPath(
        "/opt/other/logs/config-audit.jsonl.migrated.raw.quarantined-copy",
        "/opt/state",
      ),
    ).toBe(false);
    expect(
      isLegacyAuditMigrationBackupPath(
        "/opt/state/logs/../../logs/config-audit.jsonl.migrated.raw.quarantined-copy",
        "/opt/state",
      ),
    ).toBe(false);
  });

  it("propagates audit-directory inspection failures", async () => {
    await withTestDir({ prefix: "openclaw-audit-backup-inspection-" }, async (stateDir) => {
      await fs.writeFile(path.join(stateDir, "logs"), "not a directory");
      await expect(hasLegacyAuditBackupSources(stateDir)).rejects.toMatchObject({
        code: "ENOTDIR",
      });
    });
  });

  it("captures a stable active prefix while an old writer keeps appending", async () => {
    await withBackupFixture(async ({ stateDir, tempDir, sourcePath }) => {
      await fs.writeFile(
        sourcePath,
        Buffer.concat([
          Buffer.from(auditLine("initial-value-7f3c")),
          Buffer.alloc(4 * 1024 * 1024, 0x20),
        ]),
      );
      const snapshotPromise = createLegacyAuditBackupCapture({ stateDir, tempDir });
      for (let index = 0; index < 8; index += 1) {
        await fs.appendFile(sourcePath, auditLine(`late-value-${index}-9a21`));
      }
      const { snapshots } = await snapshotPromise;
      const snapshotAsset = expectDefined(snapshots[0], "snapshot");
      const snapshot = await fs.readFile(snapshotAsset.sourcePath, "utf8");

      expect(snapshotAsset.archiveSourcePath).toBe(sourcePath);
      expect(snapshot).not.toContain("initial-value-7f3c");
      expect(snapshot).not.toContain("late-value-");
      const rows = snapshot
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows).not.toHaveLength(0);
      expect(rows[0]).toMatchObject(redacted);
    });
  });

  it.each(["claim", "raw archive"])(
    "captures an interrupted %s move once without changing the live link pair",
    async (destination) => {
      await withBackupFixture(async ({ stateDir, tempDir, sourcePath, rawPath }) => {
        const claimPath = path.join(
          path.dirname(sourcePath),
          ".config-audit.jsonl.doctor-importing",
        );
        const removedPath = destination === "claim" ? sourcePath : claimPath;
        const retainedPath = destination === "claim" ? claimPath : rawPath;
        const original = auditLine("linked-value-7f3c");
        await fs.writeFile(removedPath, original);
        await fs.link(removedPath, retainedPath);
        const before = await fs.stat(removedPath, { bigint: true });

        for (let capture = 0; capture < 2; capture += 1) {
          const { asset: snapshot, text: sanitized } = await captureOne(stateDir, tempDir);
          expect(snapshot.archiveSourcePath).toBe(retainedPath);
          expect(snapshot.skippedSourcePaths).toContain(removedPath);
          expect(sanitized).not.toContain("linked-value-7f3c");
          expect(sanitized.trim().split("\n")).toHaveLength(1);
          expect(JSON.parse(sanitized)).toMatchObject(redacted);
        }

        for (const livePath of [removedPath, retainedPath]) {
          expect(await fs.readFile(livePath, "utf8")).toBe(original);
          expect(await fs.stat(livePath, { bigint: true })).toMatchObject({
            dev: before.dev,
            ino: before.ino,
            nlink: 2n,
          });
        }
      });
    },
  );

  it("rejects an audit source linked to an unrelated path", async () => {
    await withBackupFixture(async ({ stateDir, tempDir, sourcePath }) => {
      const original = auditLine("unrelated-value-7f3c");
      const unrelatedPath = path.join(path.dirname(sourcePath), "unrelated.jsonl");
      await fs.writeFile(sourcePath, original);
      await fs.link(sourcePath, unrelatedPath);

      await expect(createLegacyAuditBackupCapture({ stateDir, tempDir })).rejects.toThrow(
        /hardlink/i,
      );
      expect(await fs.readFile(sourcePath, "utf8")).toBe(original);
      expect(await fs.stat(unrelatedPath)).toMatchObject({ nlink: 2 });
    });
  });

  it.each([false, true])(
    "reconstructs a scrub-in-progress source and sanitizes its later append (linked journal: %s)",
    async (linkedJournal) => {
      await withBackupFixture(async ({ stateDir, tempDir, rawPath }) => {
        const original = Buffer.from(auditLine("original-value-7f3c"));
        const later = auditLine("later-value-9a21");
        const partial = Buffer.from(original);
        const scrubbedBytes = Math.floor(partial.length / 2);
        buildAuditScrubbedContent(scrubbedBytes).copy(partial);
        await fs.writeFile(rawPath, Buffer.concat([partial, Buffer.from(later)]));
        await writeAuditRestoreJournal(rawPath, original, { restoredBytes: 0, scrubbedBytes });
        const restorePath = `${rawPath}.doctor-scrub-restore`;
        const stagingPath = `${rawPath}.doctor-scrub-staging`;
        const journal = await fs.readFile(restorePath, "utf8");
        if (linkedJournal) {
          await fs.link(restorePath, stagingPath);
        }

        const { asset: snapshotAsset, text: snapshot } = await captureOne(stateDir, tempDir);
        expect(snapshotAsset.archiveSourcePath).toBe(rawPath);
        expect(snapshot).not.toContain("original-value-7f3c");
        expect(snapshot).not.toContain("later-value-9a21");
        expect(
          snapshot
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line)),
        ).toMatchObject([redacted, redacted]);
        if (linkedJournal) {
          for (const journalPath of [restorePath, stagingPath]) {
            expect(snapshotAsset.skippedSourcePaths).toContain(journalPath);
            expect(await fs.readFile(journalPath, "utf8")).toBe(journal);
            expect(await fs.stat(journalPath)).toMatchObject({ nlink: 2 });
          }
        }
      });
    },
  );

  it("ignores a stale restore journal after the raw archive is replaced", async () => {
    await withBackupFixture(async ({ stateDir, tempDir, rawPath }) => {
      const original = Buffer.from(auditLine("old-value-7f3c"));
      const replacement = configAuditRecord("replacement-value-9a21", { event: "config.delete" });
      await fs.writeFile(rawPath, `${JSON.stringify(replacement)}\n`);
      await writeAuditRestoreJournal(rawPath, original);

      const { text } = await captureOne(stateDir, tempDir);
      expect(JSON.parse(text)).toMatchObject({ event: "config.delete", ...redacted });
    });
  });
});
