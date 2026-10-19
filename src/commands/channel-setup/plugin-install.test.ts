import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeMeta } from "../../flows/channel-setup.test-helpers.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { invokePluginArtifactInstallMock } from "../../plugins/test-helpers/install-fixtures.js";

const installPluginFromNpmSpec = vi.fn();
const resolveNpmSpecMetadata = vi.hoisted(() => vi.fn());
vi.mock("../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata,
}));
const applyPluginAutoEnable = vi.fn();
vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
    invokePluginArtifactInstallMock(installPluginFromNpmSpec, params),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnable(...args),
}));

const resolveBundledPluginSources = vi.fn();
const getChannelPluginCatalogEntry = vi.fn();
const listChannelPluginCatalogEntries = vi.fn((..._args: unknown[]) => []);
vi.mock("../../channels/plugins/catalog.js", () => {
  return {
    getChannelPluginCatalogEntry: (...args: unknown[]) => getChannelPluginCatalogEntry(...args),
    listRawChannelPluginCatalogEntries: (...args: unknown[]) =>
      listChannelPluginCatalogEntries(...args),
  };
});

const loadPluginManifestRegistryCore = vi.fn();
vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: (
      params: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
    ) =>
      // Artifact consent reads real fixtures; setup inventory remains independently mocked.
      params?.discovery
        ? actual.loadPluginManifestRegistryCore(params)
        : loadPluginManifestRegistryCore(params),
  };
});

vi.mock("../../plugins/bundled-sources.js", () => ({
  findBundledPluginSourceInMap: ({
    bundled,
    lookup,
  }: {
    bundled: ReadonlyMap<string, { pluginId: string; localPath: string; npmSpec?: string }>;
    lookup: { kind: "pluginId" | "npmSpec"; value: string };
  }) => {
    const targetValue = lookup.value.trim();
    if (!targetValue) {
      return undefined;
    }
    if (lookup.kind === "pluginId") {
      return bundled.get(targetValue);
    }
    return [...bundled.values()].find((source) => source.npmSpec === targetValue);
  },
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSources(...args),
}));

vi.mock("../../plugins/loader.js", () => {
  const load = vi.fn();
  return { loadOpenClawPlugins: load, loadPluginRegistryHandle: load };
});

const discoverOpenClawPlugins = vi.fn((_args?: unknown) => ({
  candidates: [] as PluginCandidate[],
  diagnostics: [],
}));
vi.mock("../../plugins/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/discovery.js")>()),
  discoverOpenClawPlugins: (args: unknown) => discoverOpenClawPlugins(args),
}));

import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginCandidate } from "../../plugins/discovery.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../../plugins/install-types.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { makePrompter, makeRuntime } from "../setup/__tests__/test-utils.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";

const bundledChatNpmSpec = "@openclaw/bundled-chat@1.2.3";
const bundledChatIntegrity = "sha512-bundled-chat";
const bundledChatForkNpmSpec = "@vendor/bundled-chat-fork@1.2.3";
const bundledChatForkIntegrity = "sha512-vendor-bundled-chat-fork";
const ORIGINAL_OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const baseEntry: ChannelPluginCatalogEntry = {
  id: "bundled-chat",
  pluginId: "bundled-chat",
  meta: makeMeta("bundled-chat", "Bundled Chat", { docsLabel: "bundled chat", blurb: "Test" }),
  install: {
    npmSpec: bundledChatNpmSpec,
    localPath: bundledPluginRoot("bundled-chat"),
    expectedIntegrity: bundledChatIntegrity,
  },
};

function choicePrompter(choice = "npm") {
  return makePrompter({
    select: vi.fn(async () => choice) as WizardPrompter["select"],
    confirm: vi.fn(async () => true),
  });
}

function install(params: Partial<Parameters<typeof ensureChannelSetupPluginInstalled>[0]> = {}) {
  return ensureChannelSetupPluginInstalled({
    cfg: {},
    entry: baseEntry,
    prompter: choicePrompter(),
    runtime: makeRuntime(),
    ...params,
  });
}

function mockBundledChatSource() {
  const { localPath } = createLocalPluginFixture();
  const source = { pluginId: "bundled-chat", localPath, npmSpec: bundledChatNpmSpec };
  resolveBundledPluginSources.mockReturnValue(new Map([["bundled-chat", source]]));
  return localPath;
}

function makeSkipInstallPrompter(acceptCapabilities = false) {
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const confirm = vi.fn(async () => acceptCapabilities);
  const prompter = makePrompter({ select: select as WizardPrompter["select"], confirm });
  return { prompter, select, confirm };
}

function mockActivationOnlyPlugin(
  origin: "bundled" | "global" | "workspace" = "bundled",
  id = "external-chat-plugin",
) {
  loadPluginManifestRegistryCore.mockReturnValue({
    plugins: [createManifestRecord({ id, origin, activation: { onChannels: ["external-chat"] } })],
    diagnostics: [],
  });
}

function createManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    syntheticAuthRefs: [],
    nonSecretAuthMarkers: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/openclaw-test/${id}`,
    source: `/tmp/openclaw-test/${id}/index.ts`,
    manifestPath: `/tmp/openclaw-test/${id}/openclaw.plugin.json`,
    ...rest,
  };
}

function loadSetupSnapshot(cfg: OpenClawConfig, pluginId?: string) {
  return loadChannelSetupPluginRegistrySnapshotForChannel({
    cfg,
    runtime: makeRuntime(),
    channel: "external-chat",
    workspaceDir: "/tmp/openclaw-workspace",
    ...(pluginId ? { pluginId } : {}),
  });
}

beforeEach(() => {
  resolveNpmSpecMetadata.mockReset().mockRejectedValue(new Error("Unseeded npm metadata query"));
  clearPluginMetadataLifecycleCaches();
  vi.clearAllMocks();
  applyPluginAutoEnable.mockImplementation((params: { config: unknown }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  }));
  resolveBundledPluginSources.mockReturnValue(new Map());
  discoverOpenClawPlugins.mockReturnValue({ candidates: [], diagnostics: [] });
  getChannelPluginCatalogEntry.mockReturnValue(undefined);
  listChannelPluginCatalogEntries.mockReturnValue([]);
  loadPluginManifestRegistryCore.mockReturnValue({ plugins: [], diagnostics: [] });
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  if (ORIGINAL_OPENCLAW_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_OPENCLAW_STATE_DIR;
  }
});

function createLocalPluginFixture(pluginId = "bundled-chat") {
  const workspaceDir = tempDirs.make("openclaw-channel-plugin-");
  const localPath = path.join(workspaceDir, bundledPluginRoot("bundled-chat"));
  fs.mkdirSync(path.join(workspaceDir, ".git"));
  fs.mkdirSync(localPath, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir: localPath,
    pluginId,
  });
  return { workspaceDir, localPath, runtimeMarker: fixture.runtimeMarker };
}

async function runInitialValueForChannel(channel: "dev" | "beta") {
  const { prompter, select } = makeSkipInstallPrompter();
  const { workspaceDir } = createLocalPluginFixture();

  await install({ cfg: { update: { channel } }, prompter, workspaceDir });

  return select.mock.calls[0]?.[0];
}

function expectPluginLoadedFromLocalPath(
  result: Awaited<ReturnType<typeof ensureChannelSetupPluginInstalled>>,
  expectedPath: string,
) {
  expect(result.installed).toBe(true);
  expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
}

function expectFields(value: unknown, expected: Record<string, unknown>) {
  expect(value).toEqual(expect.objectContaining(expected));
}

function expectLoadOpenClawPluginFields(expected: Record<string, unknown>, cfg?: OpenClawConfig) {
  expectFields(vi.mocked(loadOpenClawPlugins).mock.calls[0]?.[0], {
    ...(cfg
      ? {
          config: cfg,
          activationSourceConfig: cfg,
          autoEnabledReasons: {},
          workspaceDir: "/tmp/openclaw-workspace",
          cache: false,
          includeSetupOnlyChannelPlugins: true,
          channelPluginLoadIntent: "setup",
        }
      : {}),
    ...expected,
  });
}

describe("ensureChannelSetupPluginInstalled", () => {
  it("installs from npm and enables the plugin", async () => {
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "bundled-chat",
      targetDir: "/tmp/bundled-chat",
      extensions: [],
    });

    const result = await install({ cfg: { plugins: { allow: ["bundled-chat"] } } });

    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.entries?.["bundled-chat"]?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toContain("bundled-chat");
    expectFields(result.cfg.plugins?.installs?.["bundled-chat"], {
      source: "npm",
      spec: bundledChatNpmSpec,
      installPath: "/tmp/bundled-chat",
    });
    expectFields(installPluginFromNpmSpec.mock.calls[0]?.[0], {
      expectedIntegrity: bundledChatIntegrity,
      spec: bundledChatNpmSpec,
    });
  });

  it("installs npm channel plugins into the active profile extensions dir", async () => {
    const profileStateDir = tempDirs.make("openclaw-ledger-channel-");
    process.env.OPENCLAW_STATE_DIR = profileStateDir;
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "bundled-chat",
      targetDir: path.join(profileStateDir, "extensions", "bundled-chat"),
      extensions: [],
    });

    await install();

    expectFields(installPluginFromNpmSpec.mock.calls[0]?.[0], {
      extensionsDir: path.resolve(profileStateDir, "extensions"),
      spec: bundledChatNpmSpec,
    });
  });

  it("uses local path when selected", async () => {
    const { workspaceDir, localPath, runtimeMarker } = createLocalPluginFixture();

    const result = await install({ prompter: choicePrompter("local"), workspaceDir });

    expectPluginLoadedFromLocalPath(result, localPath);
    expect(result.cfg.plugins?.entries?.["bundled-chat"]?.enabled).toBe(true);
    expect(result.cfg.plugins?.installs?.["bundled-chat"]?.acceptedSurface).toBeDefined();
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });
  it("uses the catalog plugin id for local-path installs", async () => {
    const { workspaceDir } = createLocalPluginFixture("@vendor/external-chat-plugin");

    const result = await install({
      entry: {
        ...baseEntry,
        id: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
      },
      prompter: choicePrompter("local"),
      workspaceDir,
    });

    expect(result.installed).toBe(true);
    expect(result.pluginId).toBe("@vendor/external-chat-plugin");
    expect(result.cfg.plugins?.entries?.["@vendor/external-chat-plugin"]?.enabled).toBe(true);
  });

  it("defaults to local on dev channel when local path exists", async () => {
    expectFields(await runInitialValueForChannel("dev"), { initialValue: "local" });
  });

  it("does not default to bundled local path when an external catalog overrides the npm spec", async () => {
    const { prompter, select } = makeSkipInstallPrompter();
    mockBundledChatSource();

    await install({
      cfg: { update: { channel: "beta" } },
      entry: {
        id: "bundled-chat",
        meta: makeMeta("bundled-chat", "Bundled Chat", { blurb: "Test" }),
        install: {
          npmSpec: bundledChatForkNpmSpec,
          expectedIntegrity: bundledChatForkIntegrity,
        },
      },
      prompter,
    });

    expectFields(select.mock.calls[0]?.[0], {
      initialValue: "npm",
      options: [
        expect.objectContaining({
          value: "npm",
          label: `Download from npm (${bundledChatForkNpmSpec})`,
        }),
        expect.objectContaining({ value: "skip" }),
      ],
    });
  });

  it.each([
    [
      "unpublished package",
      PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
      "Package not found on npm: @openclaw/bundled-chat@1.2.3",
      true,
    ],
    ["untyped E404", undefined, "E404 while installing a dependency", false],
    ["integrity failure", undefined, "aborted: npm package integrity drift", false],
    [
      "policy failure",
      PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
      "Plugin install blocked by policy",
      false,
    ],
  ] as const)(
    "only falls back for unpublished packages: %s",
    async (_scenario, code, error, fallback) => {
      const runtime = makeRuntime();
      const note = vi.fn(async () => {});
      const confirm = vi.fn(async () => true);
      const prompter = { ...choicePrompter(), note, confirm };
      const cfg: OpenClawConfig = {};
      const { workspaceDir, localPath } = createLocalPluginFixture();
      installPluginFromNpmSpec.mockResolvedValue({
        ok: false,
        code,
        error,
      });

      const result = await install({ cfg, prompter, runtime, workspaceDir });

      expect(note).toHaveBeenCalled();
      expect(installPluginFromNpmSpec).toHaveBeenCalledOnce();
      if (fallback) {
        expectPluginLoadedFromLocalPath(result, localPath);
        expect(result.cfg.plugins?.installs?.["bundled-chat"]?.acceptedSurface).toBeDefined();
        expect(runtime.error).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({
          cfg,
          installed: false,
          pluginId: "bundled-chat",
          status: "failed",
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(runtime.error).toHaveBeenCalledWith(`Plugin install failed: ${error}`);
      }
    },
  );

  it.each([true, false])(
    "auto-selects the only npm source but requires capability consent, accepted=%s",
    async (acceptCapabilities) => {
      const runtime = makeRuntime();
      const { prompter, select, confirm } = makeSkipInstallPrompter(acceptCapabilities);
      const cfg: OpenClawConfig = {};
      const npmOnlyEntry: ChannelPluginCatalogEntry = {
        id: "wecom",
        pluginId: "wecom-openclaw-plugin",
        meta: makeMeta("wecom", "WeCom", { blurb: "WeCom channel" }),
        install: {
          npmSpec: "@openclaw/wecom@2026.4.23",
        },
      };
      installPluginFromNpmSpec.mockResolvedValue({
        ok: true,
        pluginId: "wecom-openclaw-plugin",
        targetDir: "/tmp/wecom-openclaw-plugin",
      });
      resolveBundledPluginSources.mockReturnValue(new Map());

      const result = await install({
        cfg,
        entry: npmOnlyEntry,
        prompter,
        runtime,
        autoConfirmSingleSource: true,
      });

      expect(select).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledOnce();
      expect(result.installed).toBe(acceptCapabilities);
      expect(result.pluginId).toBe("wecom-openclaw-plugin");
      if (!acceptCapabilities) {
        expect(result.cfg).toBe(cfg);
        expect(runtime.error).toHaveBeenCalledWith(expect.stringMatching(/capabilit/i));
      }
    },
  );

  it("loads setup snapshots from the auto-enabled config snapshot", async () => {
    const cfg: OpenClawConfig = {
      plugins: {},
      channels: { "external-chat": { enabled: true } } as never,
    };
    const autoEnabledConfig = {
      ...cfg,
      plugins: { entries: { "external-chat": { enabled: true } } },
    };
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });

    await loadSetupSnapshot(cfg);

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expectLoadOpenClawPluginFields({
      config: autoEnabledConfig,
      activationSourceConfig: cfg,
      autoEnabledReasons: {},
      onlyPluginIds: [],
    });
  });

  it("falls back to the bundled plugin for untrusted workspace shadows", async () => {
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry
      .mockReturnValueOnce({ pluginId: "evil-external-chat-shadow", origin: "workspace" })
      .mockReturnValueOnce({ pluginId: "@vendor/external-chat-plugin", origin: "bundled" });

    await loadSetupSnapshot(cfg);

    expectLoadOpenClawPluginFields({ onlyPluginIds: ["@vendor/external-chat-plugin"] }, cfg);
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
      env: undefined,
      excludePluginRefs: [{ pluginId: "evil-external-chat-shadow", origin: "workspace" }],
    });
  });

  it("scopes snapshots by activation-declared channel ownership when direct channel lists are empty", async () => {
    const cfg: OpenClawConfig = {};
    const id = "custom-external-chat-plugin";
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: id,
          source: `/tmp/openclaw-test/${id}/index.ts`,
          rootDir: `/tmp/openclaw-test/${id}`,
          origin: "bundled",
        },
      ],
      diagnostics: [],
    });
    mockActivationOnlyPlugin("bundled", id);

    await loadSetupSnapshot(cfg);

    expectLoadOpenClawPluginFields({ onlyPluginIds: [id] });
    expect(
      loadPluginManifestRegistryCore.mock.calls.some(
        ([args]) =>
          isRecord(args) &&
          args.config === cfg &&
          args.workspaceDir === "/tmp/openclaw-workspace" &&
          Array.isArray(args.candidates) &&
          args.candidates.some(
            (candidate) =>
              isRecord(candidate) && candidate.idHint === id && candidate.origin === "bundled",
          ),
      ),
    ).toBe(true);
    expect(
      loadPluginManifestRegistryCore.mock.calls.every(
        ([params]) => !Object.hasOwn(params ?? {}, "cache"),
      ),
    ).toBe(true);
  });

  it.each<[string, "bundled" | "workspace" | "global", OpenClawConfig]>([
    ["unconfigured workspace", "workspace", {}],
    ["allowlist-excluded bundled", "bundled", { plugins: { allow: ["other-plugin"] } }],
    ["denied bundled", "bundled", { plugins: { deny: ["external-chat-plugin"] } }],
    [
      "disabled workspace despite explicit trust",
      "workspace",
      {
        plugins: {
          enabled: true,
          allow: ["external-chat-plugin"],
          entries: { "external-chat-plugin": { enabled: false } },
        },
      },
    ],
    [
      "disabled bundled",
      "bundled",
      {
        plugins: { entries: { "external-chat-plugin": { enabled: false } } },
      },
    ],
    ["unenabled global", "global", {}],
  ])("does not trust %s activation-only ownership", async (_name, origin, cfg) => {
    mockActivationOnlyPlugin(origin);

    await loadSetupSnapshot(cfg);

    expect(loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadOpenClawPlugins).mock.calls[0]?.[0].onlyPluginIds).toStrictEqual([]);
  });

  it("scopes snapshots by plugin id when channel and plugin ids differ", async () => {
    const cfg: OpenClawConfig = {};

    await loadSetupSnapshot(cfg, "@vendor/external-chat-plugin");

    expectLoadOpenClawPluginFields({ onlyPluginIds: ["@vendor/external-chat-plugin"] }, cfg);
  });
});
