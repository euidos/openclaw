import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "./state-migrations.state-dir.js";

async function withStateDirFixture(
  run: (fixture: {
    root: string;
    legacyDir: string;
    targetDir: string;
    write: (file: string, bytes: string | Buffer) => void;
    migrate: (env?: NodeJS.ProcessEnv) => ReturnType<typeof autoMigrateLegacyStateDir>;
  }) => Promise<void>,
): Promise<void> {
  try {
    await withTestDir({ prefix: "openclaw-state-dir-" }, async (root) => {
      await run({
        root,
        legacyDir: path.join(root, ".clawdbot"),
        targetDir: path.join(root, ".openclaw"),
        write(file, bytes) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bytes);
        },
        migrate: (env = {}) => autoMigrateLegacyStateDir({ env, homedir: () => root }),
      });
    });
  } finally {
    resetAutoMigrateLegacyStateDirForTest();
  }
}

describe("legacy state dir auto-migration", () => {
  it.each(["config", "environment"])(
    "preserves retired OAuth sidecars selected by %s and reports their relocated recovery path",
    async (selection) => {
      await withStateDirFixture(async ({ root, legacyDir, targetDir, write, migrate }) => {
        const oauthDir = path.join(legacyDir, "oauth$old");
        const sidecarPath = path.join(oauthDir, "auth-profiles", `${"a".repeat(32)}.json`);
        const sidecarBytes = Buffer.from("retired encrypted bytes\u0000not parsed\n");
        const env: NodeJS.ProcessEnv = {
          HOME: root,
          ...(selection === "environment" ? { OPENCLAW_OAUTH_DIR: oauthDir } : {}),
        };
        write(sidecarPath, sidecarBytes);
        const authStorePath = path.join(legacyDir, "agents/main/agent/auth-profiles.json");
        write(
          authStorePath,
          JSON.stringify({
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                oauthRef: {
                  source: "openclaw-credentials",
                  provider: "openai-codex",
                  id: "a".repeat(32),
                },
              },
            },
          }),
        );
        const configPath = path.join(legacyDir, "clawdbot.json");
        const configBytes = JSON.stringify(
          selection === "config"
            ? { env: { vars: { OPENCLAW_OAUTH_DIR: "~/.clawdbot/oauth$old" } } }
            : {},
        );
        write(configPath, configBytes);
        const envBefore = { ...env };

        const result = await migrate(env);
        const movedOAuthDir = path.join(targetDir, "oauth$old");
        expect(result).toMatchObject({ migrated: true, skipped: false });
        expect(result.warnings).toEqual([
          expect.stringContaining(`OPENCLAW_OAUTH_DIR='${movedOAuthDir}' openclaw doctor --fix`),
        ]);
        expect(result.warnings[0]).toContain(oauthDir);
        expect(result.warnings[0]).toContain("update the configured OPENCLAW_OAUTH_DIR");
        expect(fs.existsSync(legacyDir)).toBe(false);
        expect(
          fs.readFileSync(path.join(movedOAuthDir, "auth-profiles", `${"a".repeat(32)}.json`)),
        ).toEqual(sidecarBytes);
        expect(fs.readFileSync(path.join(targetDir, "clawdbot.json"), "utf8")).toBe(configBytes);
        expect(env).toEqual(envBefore);
      });
    },
  );

  it("skips a legacy symlinked state dir when it points outside supported legacy roots", async () => {
    await withStateDirFixture(async ({ root, legacyDir: legacySymlink, write, migrate }) => {
      const legacyDir = path.join(root, "legacy-state-source");
      write(path.join(legacyDir, "marker.txt"), "ok");
      const dirLinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(legacyDir, legacySymlink, dirLinkType);

      const result = await migrate();

      expect(result.migrated).toBe(false);
      expect(result.warnings).toEqual([
        `Legacy state path is not a directory: ${legacySymlink}; move it manually before rerunning Doctor.`,
      ]);
      expect(fs.readFileSync(path.join(legacyDir, "marker.txt"), "utf8")).toBe("ok");
      expect(fs.readFileSync(path.join(legacySymlink, "marker.txt"), "utf8")).toBe("ok");
    });
  });

  it("preserves both directories when the canonical root already exists", async () => {
    await withStateDirFixture(async ({ legacyDir, targetDir, write, migrate }) => {
      fs.mkdirSync(legacyDir, { recursive: true });
      write(path.join(targetDir, "openclaw.json"), "{}");
      const result = await migrate();

      expect(result).toMatchObject({ migrated: false, skipped: false, changes: [] });
      expect(result.warnings).toEqual([
        `Both ${legacyDir} and ${targetDir} exist; leave them unchanged and move the legacy data manually before rerunning Doctor.`,
      ]);
      expect(fs.lstatSync(legacyDir).isDirectory()).toBe(true);
      expect(fs.readdirSync(legacyDir)).toEqual([]);
      expect(fs.readFileSync(path.join(targetDir, "openclaw.json"), "utf8")).toBe("{}");
    });
  });

  it.each(["OPENCLAW_STATE_DIR", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH"])(
    "skips state-dir migration when %s is explicitly set",
    async (selector) => {
      await withStateDirFixture(async ({ root, legacyDir, migrate }) => {
        fs.mkdirSync(legacyDir, { recursive: true });
        const result = await migrate({ [selector]: path.join(root, "custom-state") });
        expect(result).toEqual({ migrated: false, skipped: true, changes: [], warnings: [] });
        expect(fs.existsSync(legacyDir)).toBe(true);
      });
    },
  );

  it("relocates pre-July plugin JSON unchanged for Doctor repair", async () => {
    await withStateDirFixture(async ({ legacyDir: stateDir, targetDir, write, migrate }) => {
      const sourcePath = path.join(stateDir, "plugins", "installs.json");
      const source = '{"records":{"demo":{"source":"npm","spec":"demo@1.0.0"}}}';
      write(sourcePath, source);
      const result = await migrate();
      expect(result).toMatchObject({ migrated: true, skipped: false, warnings: [] });
      expect(fs.readFileSync(path.join(targetDir, "plugins", "installs.json"), "utf8")).toBe(
        source,
      );
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
      expect(fs.existsSync(path.join(targetDir, "state", "openclaw.sqlite"))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);
    });
  });

  it("relocates retired session delivery state unchanged for Doctor archival", async () => {
    await withStateDirFixture(async ({ legacyDir, targetDir, write, migrate }) => {
      const sourcePath = path.join(legacyDir, "session-delivery-queue/pending.json");
      const sourceBytes = Buffer.from('{"id":"retired","payloads":[{"text":"preserve"}]}\n');
      write(path.join(legacyDir, "marker.txt"), "ok");
      write(sourcePath, sourceBytes);
      const recovered = await migrate();
      expect(recovered).toMatchObject({ migrated: true, skipped: false, warnings: [] });
      expect(fs.existsSync(legacyDir)).toBe(false);
      expect(fs.readFileSync(path.join(targetDir, "session-delivery-queue/pending.json"))).toEqual(
        sourceBytes,
      );
      expect(fs.readFileSync(path.join(targetDir, "marker.txt"), "utf8")).toBe("ok");
    });
  });
});
