import { describe, expect, it, vi } from "vitest";
import { registerTabAccessEvents } from "./tab-access-events.js";
import { createTabAccessPolicy, type TabAccessEpoch, type TabAccessMode } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

function chromeEvent<Args extends unknown[]>() {
  let listener: (...args: Args) => void = () => {
    throw new Error("Chrome event listener was not registered");
  };
  return {
    addListener(next: (...args: Args) => void) {
      listener = next;
    },
    emit(...args: Args) {
      listener(...args);
    },
  };
}

const navigationEvents = [
  { method: "Network.responseReceived", params: { requestId: "navigation-1" } },
  { method: "Runtime.executionContextCreated", params: { context: { id: 12 } } },
  { method: "Page.frameNavigated", params: { frame: { id: "frame-7", loaderId: "loader-1" } } },
  { method: "Page.lifecycleEvent", params: { frameId: "frame-7", name: "load" } },
];

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const drainEvents = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

async function createNavigationHarness(
  mode: TabAccessMode,
  { fileAccessAllowed = true, groupId = mode === "selected" ? 11 : -1 } = {},
) {
  let tab: BrowserTabSnapshot = {
    id: 7,
    url: "https://source.example/",
    groupId,
    incognito: false,
  };
  const chromeApi = {
    extension: { isAllowedFileSchemeAccess: async () => fileAccessAllowed },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    tabs: {
      get: vi.fn(async (_tabId: number) => tab),
      query: vi.fn(async () => [tab]),
      onUpdated: chromeEvent<[number, { groupId?: number; url?: string }, BrowserTabSnapshot]>(),
      onRemoved: chromeEvent<[number]>(),
      onReplaced: chromeEvent<[number, number]>(),
    },
    tabGroups: {
      onUpdated: chromeEvent<[group?: { id: number; title?: string }]>(),
      onRemoved: chromeEvent<[group?: { id: number; title?: string }]>(),
    },
    debugger: {
      onEvent: chromeEvent<[{ tabId?: number; sessionId?: string }, string, unknown]>(),
      onDetach: chromeEvent<[{ tabId?: number }, string]>(),
    },
  };
  const policy = createTabAccessPolicy({
    chromeApi,
    isSelectedTab: async (candidate) => candidate.groupId === 11,
  });
  await policy.initialize(mode, true);
  const attachmentEpoch = policy.capture(7);
  await policy.requireTab(7, attachmentEpoch);
  const attachments = new Map<number, { epoch: TabAccessEpoch }>([[7, { epoch: attachmentEpoch }]]);
  const send = vi.fn<(message: Record<string, unknown>) => void>();
  const detachDebugger = vi.fn(async (tabId: number) => {
    attachments.delete(tabId);
  });
  const commitRoot = (url: string, loaderId = "return") => {
    tab = { ...tab, url };
    chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
      frame: { id: "root", loaderId, url },
    });
  };
  registerTabAccessEvents({
    chromeApi,
    accessReady: Promise.resolve(),
    policy,
    attachments,
    nativeDetached: (tabId: number) => attachments.delete(tabId),
    send,
    scheduleTabsSync() {},
    detachDebugger,
    pauseTab: async (tabId) => await policy.pause(tabId),
    removeTabFromOpenClawGroup: async () => {},
    runAccessMutation: async (task) => await task(),
  });
  return {
    chromeApi,
    policy,
    attachmentEpoch,
    attachments,
    send,
    detachDebugger,
    commitRoot,
    async controlBlank() {
      const epoch = policy.capture(7, "Page.navigate");
      await policy.requireTab(7, epoch);
      await policy.navigateTab(
        7,
        epoch,
        { url: "about:blank" },
        () => attachments.get(7)?.epoch,
        () => true,
        async (method) => {
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { id: "root", url: tab.url } } };
          }
          commitRoot("about:blank", "blank");
          return { frameId: "root", loaderId: "blank" };
        },
      );
      await expect(policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
    },
    update(update: Partial<BrowserTabSnapshot>) {
      tab = { ...tab, ...update };
      chromeApi.tabs.onUpdated.emit(7, { url: tab.url }, tab);
    },
    emitNavigation() {
      for (const { method, params } of navigationEvents) {
        chromeApi.debugger.onEvent.emit({ tabId: 7 }, method, params);
      }
    },
    deferLookup() {
      const pending = deferred<BrowserTabSnapshot>();
      chromeApi.tabs.get.mockImplementation(async () => await pending.promise);
      return async () => {
        pending.resolve(tab);
        await drainEvents();
      };
    },
  };
}

describe("Chrome navigation event access", () => {
  it("projects native child session ids only while the attachment epoch is current", async () => {
    const h = await createNavigationHarness("selected");
    const params = { frame: { id: "child", loaderId: "child-loader", url: "about:blank" } };
    for (const source of [{ tabId: 7 }, { tabId: 7, sessionId: "child-session" }]) {
      h.chromeApi.debugger.onEvent.emit(source, "Page.frameNavigated", params);
    }
    expect(h.send.mock.calls.map(([event]) => event)).toEqual([
      { type: "cdpEvent", tabId: 7, method: "Page.frameNavigated", params },
      {
        type: "cdpEvent",
        tabId: 7,
        sessionId: "child-session",
        method: "Page.frameNavigated",
        params,
      },
    ]);
    h.send.mockClear();
    h.policy.invalidateTab(7);
    h.chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", params);
    h.chromeApi.debugger.onEvent.emit(
      { tabId: 7, sessionId: "child-session" },
      "Page.frameNavigated",
      params,
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it.each(["pause", "mode change", "remove", "detach", "group rename", "group removal"])(
    "retires controlled blank authority on %s without reauthorizing it",
    async (reason) => {
      const h = await createNavigationHarness("all", { groupId: 11 });
      await h.controlBlank();
      switch (reason) {
        case "pause":
          await h.policy.pause(7);
          expect(h.policy.isDenied(7)).toBe(true);
          await h.policy.allow(7);
          break;
        case "mode change":
          h.policy.setMode("selected");
          h.policy.setMode("all");
          break;
        case "remove":
          h.chromeApi.tabs.onRemoved.emit(7);
          break;
        case "detach":
          h.chromeApi.debugger.onDetach.emit({ tabId: 7 }, "target_closed");
          break;
        case "group rename":
          h.chromeApi.tabGroups.onUpdated.emit({ id: 12, title: "Other" });
          await expect(h.policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
          h.chromeApi.tabGroups.onUpdated.emit({ id: 11, title: "Other" });
          break;
        case "group removal":
          h.chromeApi.tabGroups.onRemoved.emit({ id: 12 });
          await expect(h.policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
          h.chromeApi.tabGroups.onRemoved.emit({ id: 11 });
          break;
      }
      h.send.mockClear();
      h.emitNavigation();
      await expect(h.policy.requireTab(7)).rejects.toThrow(
        reason === "remove" ? "access was revoked" : "restricted or unavailable",
      );
      await expect(h.policy.requireTab(7)).rejects.toThrow("restricted or unavailable");
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it("discards a stale selected discovery snapshot of blank before return", async () => {
    const h = await createNavigationHarness("selected");
    await h.controlBlank();
    const stale = await h.chromeApi.tabs.query();
    const lookup = deferred<BrowserTabSnapshot[]>();
    const started = deferred<void>();
    h.chromeApi.tabs.query.mockImplementationOnce(() => {
      started.resolve();
      return lookup.promise;
    });
    const discovering = h.policy.listAccessibleTabs();
    await started.promise;
    try {
      h.commitRoot("https://return.example/");
    } finally {
      lookup.resolve(stale);
    }
    const url = "https://return.example/";
    await expect(discovering).resolves.toEqual([expect.objectContaining({ id: 7, url })]);
    await expect(h.policy.requireTab(7)).resolves.toMatchObject({ id: 7, url });
  });

  it("rereads a selected lookup overtaken by a native root commit before checking provenance", async () => {
    const h = await createNavigationHarness("selected");
    await h.controlBlank();
    const get = h.chromeApi.tabs.get.getMockImplementation()!;
    h.chromeApi.tabs.get.mockImplementationOnce(async (tabId) => {
      const stale = await get(tabId);
      h.commitRoot("https://return.example/");
      return stale;
    });
    await expect(h.policy.requireTab(7)).resolves.toMatchObject({
      url: "https://return.example/",
    });
  });

  it.each(["selected"] as const)("preserves ordered navigation events in %s mode", async (mode) => {
    const url = "https://destination.example/";
    const h = await createNavigationHarness(mode);
    const releaseLookup = h.deferLookup();
    try {
      h.update({ url });
      h.emitNavigation();

      expect(h.send.mock.calls.map(([frame]) => frame)).toEqual(
        navigationEvents.map((event) => ({ type: "cdpEvent", tabId: 7, ...event })),
      );
      await expect(h.policy.requireTab(7, h.attachmentEpoch)).rejects.toThrow("access was revoked");

      h.send.mockClear();
      h.update({ url: `${url}next` });
      h.emitNavigation();
      expect(h.send.mock.calls.map(([frame]) => frame.method)).toEqual(
        navigationEvents.map((event) => event.method),
      );
    } finally {
      await releaseLookup();
    }
    expect(h.detachDebugger).not.toHaveBeenCalled();
  });

  it.each([
    "restricted committed URL",
    "restricted pending URL",
    "incognito tab",
    "different selected group",
    "wrong tab identity",
    "paused tab",
    "changed group authority",
    "forged epoch copy",
    "replaced tab",
  ])("does not renew access for %s from a URL snapshot", async (scenario) => {
    const h = await createNavigationHarness(scenario === "paused tab" ? "all" : "selected");
    const update: Partial<BrowserTabSnapshot> = { url: "https://destination.example/" };
    if (scenario === "paused tab") {
      await h.policy.pause(7);
    }
    const releaseLookup = h.deferLookup();
    try {
      switch (scenario) {
        case "restricted committed URL":
          update.url = "chrome://settings";
          break;
        case "restricted pending URL":
          update.pendingUrl = "chrome://settings";
          break;
        case "incognito tab":
          update.incognito = true;
          break;
        case "different selected group":
          update.groupId = 12;
          break;
        case "wrong tab identity":
          update.id = 8;
          break;
        case "changed group authority":
          h.chromeApi.tabGroups.onUpdated.emit();
          break;
        case "forged epoch copy":
          h.attachments.set(7, { epoch: { ...h.attachmentEpoch } });
          break;
        case "replaced tab":
          h.chromeApi.tabs.onReplaced.emit(8, 7);
          break;
      }
      h.send.mockClear();
      h.update(update);
      h.emitNavigation();
      expect(h.send).not.toHaveBeenCalled();
    } finally {
      await releaseLookup();
    }
    // Events observed without authority must never replay after an async lookup.
    expect(h.send).not.toHaveBeenCalled();
  });

  it("preserves commands admitted after a newer tab event when an older group lookup completes", async () => {
    const h = await createNavigationHarness("selected");
    const pending = deferred<void>();
    const started = deferred<void>();
    const get = h.chromeApi.tabs.get.getMockImplementation()!;
    h.chromeApi.tabs.get.mockImplementationOnce(async (tabId) => {
      started.resolve();
      await pending.promise;
      return await get(tabId);
    });

    h.chromeApi.tabGroups.onRemoved.emit({ id: 12 });
    await started.promise;
    try {
      h.update({ url: "https://destination.example/" });
      await vi.waitFor(() => {
        h.send.mockClear();
        h.emitNavigation();
        expect(h.send).toHaveBeenCalledTimes(navigationEvents.length);
      });
      const commandEpoch = h.policy.capture(7, "Page.navigate");
      await expect(h.policy.requireTab(7, commandEpoch)).resolves.toMatchObject({ id: 7 });
      pending.resolve();
      // Drain the superseded lookup without introducing a second Chrome event.
      await drainEvents();
      await expect(h.policy.requireTab(7, commandEpoch)).resolves.toMatchObject({
        id: 7,
        url: "https://destination.example/",
      });
      expect(h.detachDebugger).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
    }
  });

  it("does not retain file permission across a recreated extension policy", async () => {
    for (const fileAccessAllowed of [true, false]) {
      const h = await createNavigationHarness("all", { fileAccessAllowed });
      const releaseLookup = h.deferLookup();
      try {
        h.update({ url: "file:///tmp/openclaw-navigation-proof.html" });
        h.emitNavigation();
        expect(h.send).toHaveBeenCalledTimes(fileAccessAllowed ? navigationEvents.length : 0);
      } finally {
        await releaseLookup();
      }
      if (!fileAccessAllowed) {
        await expect(h.policy.requireTab(7)).rejects.toThrow("restricted or unavailable");
      }
    }
  });
});
