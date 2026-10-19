import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAutoEnableResult } from "../../config/plugin-auto-enable.types.js";
import { makeCatalogEntry, makeMeta } from "../../flows/channel-setup.test-helpers.js";
import type { InstalledPluginIndex } from "../../plugins/installed-plugin-index.js";

const listPluginContributionIds = vi.hoisted(() =>
  vi.fn((_index?: unknown, _contribution?: unknown, _options?: unknown): string[] => []),
);
const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((): unknown[] => []));
const listChatChannels = vi.hoisted(() =>
  vi.fn<typeof import("../../channels/chat-meta.js").listChatChannels>(() => []),
);
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn<(args: { config: unknown; env?: NodeJS.ProcessEnv }) => PluginAutoEnableResult>(),
);

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: [] }),
  listPluginContributionIds,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: listChannelPluginCatalogEntries,
}));

vi.mock("../../channels/chat-meta.js", () => ({
  listChatChannels,
}));

vi.mock("../../secrets/channel-env-vars.js", () => ({
  getChannelEnvVars: () => [],
}));

import { resolveChannelSetupEntries } from "./discovery.js";
import { listManifestInstalledChannelIds } from "./trusted-catalog.js";

const context = { workspaceDir: "/tmp/workspace", env: { OPENCLAW_HOME: "/tmp/home" } };
const autoEnabledConfig = {
  channels: { slack: { enabled: true } },
  plugins: { allow: ["slack"] },
  autoEnabled: true,
} as never;

function discover(
  installedPlugins: Parameters<typeof resolveChannelSetupEntries>[0]["installedPlugins"],
) {
  return resolveChannelSetupEntries({ cfg: {}, installedPlugins, ...context });
}

describe("listManifestInstalledChannelIds", () => {
  beforeEach(() => {
    listPluginContributionIds.mockReset().mockReturnValue([]);
    listChannelPluginCatalogEntries.mockReset().mockReturnValue([]);
    listChatChannels.mockReset().mockReturnValue([]);
    applyPluginAutoEnable.mockReset().mockImplementation(({ config }) => ({
      config: config as never,
      changes: [] as string[],
      autoEnabledReasons: {},
    }));
  });

  it.each([false, true])("uses the auto-enabled config with a provided index: %s", (provided) => {
    const index: InstalledPluginIndex = {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: ["slack"] as string[],
      autoEnabledReasons: {
        slack: ["slack configured"],
      },
    });
    listPluginContributionIds.mockReturnValue(["slack"]);

    const installedIds = listManifestInstalledChannelIds({
      cfg: {} as never,
      ...context,
      ...(provided ? { index } : {}),
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: context.env,
    });
    expect(listPluginContributionIds).toHaveBeenCalledWith({
      contribution: "channels",
      ...(provided ? { index } : {}),
      config: autoEnabledConfig,
      ...context,
    });
    expect(installedIds).toEqual(new Set(["slack"]));
  });

  it("filters channels hidden from setup out of interactive entries", () => {
    listChatChannels.mockReturnValue([makeMeta("telegram", "Telegram", { blurb: "bot token" })]);

    const resolved = discover([
      {
        id: "qa-channel",
        meta: makeMeta("qa-channel", "QA Channel", {
          blurb: "synthetic",
          exposure: { setup: false },
        }),
      } as never,
    ]);

    expect(resolved.entries.map((entry) => entry.id)).toEqual(["telegram"]);
  });

  it("preserves source precedence and catalog metadata across setup views", () => {
    const telegramMeta = makeMeta("telegram", "Telegram", { blurb: "bot token" });
    const matrixMeta = makeMeta("matrix", "Matrix");
    listChatChannels.mockReturnValue([telegramMeta, matrixMeta]);
    const bundledCatalog = makeCatalogEntry("matrix", "Catalog Matrix");
    const installedCatalog = makeCatalogEntry("installed-chat", "Installed Chat", {
      meta: makeMeta("installed-chat", "Installed Chat", {
        aliases: ["installed"],
        detailLabel: "Installed Chat Bot",
        selectionDocsPrefix: "",
      }),
    });
    const installableCatalog = makeCatalogEntry("installable-chat", "Installable Chat");
    listPluginContributionIds.mockReturnValue(["matrix", "installed-chat"]);
    listChannelPluginCatalogEntries.mockReturnValue([
      makeCatalogEntry("telegram", "Catalog Telegram"),
      bundledCatalog,
      installedCatalog,
      installableCatalog,
    ]);

    const resolved = discover([
      {
        id: "telegram",
        meta: {
          id: "telegram",
          selectionLabel: "Telegram setup",
        },
      } as never,
    ]);

    expect(resolved).toStrictEqual({
      entries: [
        {
          id: "telegram",
          meta: { ...telegramMeta, selectionLabel: "Telegram setup" },
        },
        { id: "matrix", meta: matrixMeta },
        { id: "installed-chat", meta: installedCatalog.meta },
        { id: "installable-chat", meta: installableCatalog.meta },
      ],
      installedCatalogEntries: [bundledCatalog, installedCatalog],
      installableCatalogEntries: [installableCatalog],
      installedCatalogById: new Map([
        ["matrix", bundledCatalog],
        ["installed-chat", installedCatalog],
      ]),
      installableCatalogById: new Map([["installable-chat", installableCatalog]]),
    });
  });
});
