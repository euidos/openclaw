import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import { getChannelPluginCatalogEntry, listRawChannelPluginCatalogEntries } from "../../catalog.js";

type CatalogEntryMeta = {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  detailLabel?: string;
  aliases?: string[];
};

function createCatalogFixtureEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

function createCatalogDir(prefix: string) {
  return fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), prefix));
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

function writeExternalCatalog(
  dir: string,
  name: string,
  channel: CatalogEntryMeta,
  install: object,
) {
  const file = path.join(dir, "catalog.json");
  writeJson(file, { entries: [{ name, openclaw: { channel, install } }] });
  return file;
}

function createCatalogFallbackOnlyEnv(): NodeJS.ProcessEnv {
  return createCatalogFixtureEnv({
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  });
}

export function describeChannelCatalogEntryContract(params: {
  channelId: string;
  npmSpec: string;
  alias?: string;
}) {
  describe(`${params.channelId} channel catalog contract`, () => {
    it("keeps the shipped catalog entry aligned", () => {
      const entry = getChannelPluginCatalogEntry(params.channelId);
      expect(entry?.install.npmSpec).toBe(params.npmSpec);
      if (params.alias) {
        expect(entry?.meta.aliases).toContain(params.alias);
      }
    });
  });
}

/** Verifies catalog entries that come only from bundled manifest metadata. */
export function describeBundledMetadataOnlyChannelCatalogContract(params: {
  pluginId: string;
  packageName: string;
  npmSpec: string;
  meta: CatalogEntryMeta;
  defaultChoice?: string;
}) {
  describe(`${params.pluginId} bundled metadata-only channel catalog contract`, () => {
    it("includes the bundled metadata-only channel entry when the runtime entrypoint is omitted", () => {
      const workspaceDir = createCatalogDir("openclaw-bundled-catalog-");
      const bundledDir = path.join(workspaceDir, ".openclaw", "extensions", params.pluginId);
      fs.mkdirSync(bundledDir, { recursive: true });
      writeJson(path.join(workspaceDir, "package.json"), { name: "openclaw" });
      writeJson(path.join(bundledDir, "package.json"), {
        name: params.packageName,
        openclaw: {
          extensions: ["./index.js"],
          channel: params.meta,
          install: {
            npmSpec: params.npmSpec,
            defaultChoice: params.defaultChoice,
          },
        },
      });
      fs.writeFileSync(path.join(bundledDir, "index.js"), "export default {};\n", "utf8");
      writeJson(path.join(bundledDir, "openclaw.plugin.json"), {
        id: params.pluginId,
        channels: [params.meta.id],
        configSchema: {},
      });

      const entry = listRawChannelPluginCatalogEntries({
        workspaceDir,
        env: createCatalogFixtureEnv({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }),
      }).find((item) => item.id === params.meta.id);

      expect(entry?.install.npmSpec).toBe(params.npmSpec);
      expect(entry?.pluginId).toBe(params.pluginId);
    });
  });
}

/** Verifies fallback ordering between bundled, official, and external catalogs. */
export function describeOfficialFallbackChannelCatalogContract(params: {
  channelId: string;
  npmSpec: string;
  meta: CatalogEntryMeta;
  packageName: string;
  externalNpmSpec: string;
  externalLabel: string;
}) {
  describe(`${params.channelId} official fallback channel catalog contract`, () => {
    it("includes shipped official channel catalog entries when bundled metadata is omitted", () => {
      const dir = createCatalogDir("openclaw-official-catalog-");
      const catalogPath = path.join(dir, "channel-catalog.json");

      const entry = listRawChannelPluginCatalogEntries({
        env: createCatalogFallbackOnlyEnv(),
        officialCatalogPaths: [catalogPath],
      }).find((item) => item.id === params.channelId);

      expect(entry?.install.npmSpec).toBe(params.npmSpec);
      expect(entry?.pluginId).toBeUndefined();
      expect(entry?.trustedSourceLinkedOfficialInstall).toBe(true);
    });

    it("lets external catalogs override shipped fallback channel metadata", () => {
      const dir = createCatalogDir("openclaw-fallback-catalog-");
      const officialCatalogPath = path.join(dir, "channel-catalog.json");
      const externalCatalogPath = writeExternalCatalog(
        dir,
        params.externalNpmSpec,
        {
          ...params.meta,
          label: params.externalLabel,
          selectionLabel: params.externalLabel,
          blurb: "external override",
        },
        { npmSpec: params.externalNpmSpec },
      );

      const entry = listRawChannelPluginCatalogEntries({
        catalogPaths: [externalCatalogPath],
        officialCatalogPaths: [officialCatalogPath],
        env: createCatalogFallbackOnlyEnv(),
      }).find((item) => item.id === params.channelId);

      expect(entry?.install.npmSpec).toBe(params.externalNpmSpec);
      expect(entry?.meta.label).toBe(params.externalLabel);
      expect(entry?.pluginId).toBeUndefined();
      expect(entry?.trustedSourceLinkedOfficialInstall).toBeUndefined();
    });

    it("surfaces package-name drift in external channel catalog install metadata", () => {
      const catalogPath = writeExternalCatalog(
        createCatalogDir("openclaw-drifted-catalog-"),
        params.packageName,
        params.meta,
        { npmSpec: `${params.packageName}-fork@1.2.3`, expectedIntegrity: "sha512-drifted" },
      );

      const entry = listRawChannelPluginCatalogEntries({
        catalogPaths: [catalogPath],
        officialCatalogPaths: [],
        env: createCatalogFallbackOnlyEnv(),
      }).find((item) => item.id === params.channelId);

      expect(entry?.installSource?.npm).toMatchObject({
        packageName: `${params.packageName}-fork`,
        expectedPackageName: params.packageName,
      });
      expect(entry?.installSource?.warnings).toEqual(["npm-spec-package-name-mismatch"]);
    });
  });
}
