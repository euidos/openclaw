// GHSA-2qrv-rc5x-2g2h: setup discovery was missed by the initial channel-resolution fix.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { makeCatalogEntry, makeMeta } from "../../flows/channel-setup.test-helpers.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";

const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((_opts?: unknown): unknown[] => []));
const listChatChannels = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadPluginManifestRegistryCore = vi.hoisted(() => vi.fn());
const listPluginContributionIds = vi.hoisted(() => vi.fn((_params?: unknown): string[] => []));
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }: { config: unknown }) => ({
    config: config as never,
    changes: [] as string[],
    autoEnabledReasons: {},
  })),
);
const getChannelPluginCatalogEntry = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: listChannelPluginCatalogEntries,
  getChannelPluginCatalogEntry,
}));
vi.mock("../../channels/registry.js", () => ({
  listChatChannels,
  normalizeAnyChannelId: (channelId?: string) => channelId?.trim().toLowerCase() ?? null,
}));
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore,
}));
vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: loadPluginManifestRegistryCore,
  listPluginContributionIds,
}));
vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable,
}));
vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
}));

import { resolveChannelSetupEntries } from "./discovery.js";

beforeEach(() => {
  vi.clearAllMocks();
  loadPluginManifestRegistryCore.mockReturnValue({ plugins: [], diagnostics: [] });
  listPluginContributionIds.mockReturnValue([]);
  listChatChannels.mockReturnValue([]);
});

function createCatalogEntry(
  id: string,
  label: string,
  pluginId = id,
  origin: "workspace" | "bundled" = "workspace",
) {
  return makeCatalogEntry(id, label, {
    pluginId,
    origin,
    meta: makeMeta(id, label, { docsPath: "/", blurb: "t", order: 1 }),
    install: { npmSpec: pluginId },
  });
}

function discover(cfg: OpenClawConfig = {}) {
  return resolveChannelSetupEntries({ cfg, env: process.env, installedPlugins: [] });
}

function createManifestChannelPlugin(id: string, channels: string[]): PluginManifestRecord {
  return {
    id,
    channels,
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "workspace",
    rootDir: `/tmp/openclaw-test/${id}`,
    source: `/tmp/openclaw-test/${id}/index.ts`,
    manifestPath: `/tmp/openclaw-test/${id}/openclaw.plugin.json`,
  };
}

function mockWorkspaceOnlyCatalogEntry(entry: ReturnType<typeof createCatalogEntry>) {
  listChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
    (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace ? [] : [entry],
  );
}

describe("resolveChannelSetupEntries workspace shadow exclusion (GHSA-2qrv-rc5x-2g2h)", () => {
  it("falls back to the bundled entry for untrusted workspace shadows", () => {
    const workspaceEntry = createCatalogEntry("telegram", "Telegram", "evil-telegram-shadow");
    const bundledEntry = createCatalogEntry(
      "telegram",
      "Telegram",
      "@openclaw/telegram",
      "bundled",
    );
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    getChannelPluginCatalogEntry.mockImplementation(
      (_channel: string, opts?: { excludePluginRefs?: Array<{ pluginId: string }> }) =>
        opts?.excludePluginRefs?.some((entry) => entry.pluginId === "evil-telegram-shadow")
          ? bundledEntry
          : undefined,
    );

    discover();

    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith(
      "telegram",
      expect.objectContaining({
        excludePluginRefs: expect.arrayContaining([
          { pluginId: "evil-telegram-shadow", origin: "workspace" },
        ]),
      }),
    );
  });

  it("still returns bundled-origin entries", () => {
    const bundledEntry = createCatalogEntry(
      "telegram",
      "Telegram",
      "@openclaw/telegram",
      "bundled",
    );
    listChannelPluginCatalogEntries.mockReturnValue([bundledEntry]);

    const result = resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    const allIds = [
      ...result.installedCatalogEntries.map((e: { id: string }) => e.id),
      ...result.installableCatalogEntries.map((e: { id: string }) => e.id),
    ];
    expect(allIds).toContain("telegram");
  });

  it("keeps trusted workspace channel plugins visible in setup", () => {
    const workspaceEntry = createCatalogEntry("telegram", "Telegram", "trusted-telegram-shadow");
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [createManifestChannelPlugin("trusted-telegram-shadow", ["telegram"])],
      diagnostics: [],
    });
    listPluginContributionIds.mockReturnValue(["telegram"]);

    const result = resolveChannelSetupEntries({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["trusted-telegram-shadow"],
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installedCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["trusted-telegram-shadow"]);
  });

  it("treats auto-enabled workspace channel plugins as trusted during setup discovery", () => {
    const workspaceEntry = createCatalogEntry("telegram", "Telegram", "trusted-telegram-shadow");
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      config: {
        ...(config as Record<string, unknown>),
        plugins: {
          enabled: true,
          allow: ["trusted-telegram-shadow"],
        },
      } as never,
      changes: ["trusted-telegram-shadow"] as string[],
      autoEnabledReasons: {
        "trusted-telegram-shadow": ["channel configured"],
      },
    }));
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [createManifestChannelPlugin("trusted-telegram-shadow", ["telegram"])],
      diagnostics: [],
    });
    listPluginContributionIds.mockReturnValue(["telegram"]);

    const result = discover({ channels: { telegram: { token: "existing-token" } } } as never);

    expect(result.installedCatalogEntries.map((entry) => entry.pluginId)).toEqual([
      "trusted-telegram-shadow",
    ]);
  });

  it("keeps workspace-only install candidates visible until the user trusts them", () => {
    mockWorkspaceOnlyCatalogEntry(createCatalogEntry("my-cool-plugin", "My Cool Plugin"));

    const result = discover();

    expect(result.installableCatalogEntries.map((entry) => entry.pluginId)).toEqual([
      "my-cool-plugin",
    ]);
  });

  it("does not surface untrusted workspace-only entries as installed", () => {
    mockWorkspaceOnlyCatalogEntry(createCatalogEntry("my-cool-plugin", "My Cool Plugin"));
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      config: {
        ...(config as Record<string, unknown>),
        plugins: {},
      } as never,
      changes: [] as string[],
      autoEnabledReasons: {},
    }));
    loadPluginManifestRegistryCore.mockReturnValue({
      plugins: [createManifestChannelPlugin("my-cool-plugin", ["my-cool-plugin"])],
      diagnostics: [],
    });
    listPluginContributionIds.mockReturnValue(["my-cool-plugin"]);

    const result = discover({ channels: { "my-cool-plugin": { token: "existing-token" } } });

    expect(result.installedCatalogEntries).toStrictEqual([]);
  });
});
