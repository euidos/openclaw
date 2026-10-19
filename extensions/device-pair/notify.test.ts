import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { listDevicePairing as listDevicePairingFn } from "openclaw/plugin-sdk/device-bootstrap";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
  createTestPluginApi,
} from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
  DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
  notifyRequestStoreKey,
  notifySubscriberStoreKey,
  type NotifySeenRequest,
  type NotifySubscription,
} from "./notify-state.js";

const listDevicePairingMock = vi.hoisted(() =>
  vi.fn<typeof listDevicePairingFn>(async () => ({ pending: [], paired: [] })),
);

vi.mock("openclaw/plugin-sdk/device-bootstrap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/device-bootstrap")>()),
  listDevicePairing: listDevicePairingMock,
}));

import { startPairingNotifier, handleNotifyCommand } from "./notify.js";
type PendingRequest = Awaited<ReturnType<typeof listDevicePairingMock>>["pending"][number];
type NotifyContext = Partial<Parameters<typeof handleNotifyCommand>[0]["ctx"]>;

function createNotifier(api: Parameters<typeof startPairingNotifier>[0]) {
  const scheduler = createTestPluginServiceScheduler();
  return { start: () => startPairingNotifier(api, scheduler), stop: scheduler.stop };
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/device-bootstrap");
  vi.resetModules();
});

describe("device-pair notify persistence", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let storage: ReturnType<typeof observeNotifyStorage>;
  let sendText: ReturnType<typeof createSender>;
  let api: ReturnType<typeof createApi>;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [], paired: [] });
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "device-pair-notify-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    storage = observeNotifyStorage();
    sendText = createSender();
    api = createApi(sendText, storage.openKeyedStore);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  function openStore<T>(options: OpenKeyedStoreOptions) {
    return createPluginStateKeyedStoreV2ForTests<T>(
      "device-pair",
      { ...options, env: options.env ?? env },
      { assertCurrent() {} },
    );
  }

  function createApi(
    sender?: ReturnType<typeof vi.fn>,
    openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T, 2> = openStore,
  ) {
    const loadAdapter = vi.fn(async () => (sender ? { sendText: sender } : undefined));
    return createTestPluginApi({
      logger: { info() {}, warn: storage.pollFailed, error() {} },
      runtime: {
        state: {
          openKeyedStore,
          openKeyedStoreV2: openKeyedStore,
        },
        channel: { outbound: { loadAdapter } },
      } as never,
    });
  }

  function notifyCommand(
    commandApi: ReturnType<typeof createApi>,
    action: string,
    ctx: NotifyContext = {},
  ) {
    return handleNotifyCommand({
      api: commandApi,
      action,
      ctx: { channel: "telegram", senderId: "chat-123", ...ctx },
    });
  }

  const pendingRequest = (overrides: Partial<PendingRequest>, index: number): PendingRequest => ({
    requestId: "request-1",
    deviceId: `device-${index + 1}`,
    publicKey: `public-key-${index + 1}`,
    ts: 2_000,
    ...overrides,
  });
  function setPendingRequests(...requests: Partial<PendingRequest>[]) {
    listDevicePairingMock.mockResolvedValue({
      pending: requests.map(pendingRequest),
      paired: [],
    });
  }

  const delivery = { channel: "telegram", to: "chat-123" };
  const createSender = () => vi.fn<(payload: unknown) => Promise<unknown>>(async () => delivery);
  const subscriber = (overrides: Partial<NotifySubscription> = {}): NotifySubscription => ({
    to: "chat-123",
    mode: "persistent",
    addedAtMs: 1,
    ...overrides,
  });
  function freezeTime() {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  }
  function delayedSender(next?: () => Promise<unknown>) {
    const pending = createDeferred<unknown>();
    const entered = createDeferred<void>();
    const send = () => {
      entered.resolve();
      return pending.promise;
    };
    sendText.mockImplementation(send);
    if (next) {
      sendText.mockImplementationOnce(send).mockImplementation(next);
    }
    return { pending, entered };
  }
  function createClock() {
    freezeTime();
    const clock = createGatewaySchedulerClock(1_000);
    const gateway = createTestGatewayScheduler(clock.clock);
    return { clock, gateway, scheduler: createTestPluginServiceScheduler(gateway) };
  }

  function openSubscriberStore() {
    return openStore<NotifySubscription>({
      namespace: DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE,
      maxEntries: DEVICE_PAIR_NOTIFY_SUBSCRIBER_MAX_ENTRIES,
    });
  }

  function observeNotifyStorage() {
    const reads: Promise<unknown>[] = [];
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const waitFor = <T>(operation: Promise<T>): Promise<T> =>
      Promise.race([operation, failed.promise]);
    const stored = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const storedReceipt = (key: string) => {
      let receipt = stored.get(key);
      if (!receipt) {
        receipt = createDeferred<void>();
        stored.set(key, receipt);
      }
      return receipt;
    };
    const openKeyedStore = <T>(options: OpenKeyedStoreOptions) => {
      const store = openStore<T>(options);
      const entries = store.entries.bind(store);
      store.entries = () => {
        const reading = entries();
        reads.push(reading);
        return reading;
      };
      if (options.namespace === DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE) {
        const register = store.register.bind(store);
        store.register = async (key, value, opts) => {
          await register(key, value, opts);
          storedReceipt(key).resolve();
        };
      }
      return store;
    };
    return {
      openKeyedStore,
      takeStoreReads: () => reads.splice(0),
      async advanceAndRead(ms = 10_000) {
        await vi.advanceTimersByTimeAsync(ms);
        await Promise.all(reads.splice(0));
      },
      waitFor,
      requestStored: (requestId: string) =>
        waitFor(storedReceipt(notifyRequestStoreKey(requestId)).promise),
      pollFailed: (message: string) => failed.reject(new Error(message)),
    };
  }

  it("reports live subscriber counts", async () => {
    freezeTime();
    const row = subscriber();
    const subscriberStore = openSubscriberStore();
    await subscriberStore.register(notifySubscriberStoreKey(row), row);
    await subscriberStore.register("expired", row, { ttlMs: 1 });
    await openStore({ namespace: "other", maxEntries: 10 }).register("sibling", row);
    vi.setSystemTime(1_001);
    for (const [senderId, mode] of [
      ["chat-123", "persistent"],
      ["missing", "off"],
    ]) {
      const status = await notifyCommand(api, "status", { senderId });
      expect(status.text).toContain(`Mode: ${mode}`);
      expect(status.text).toContain("Subscribers: 1");
      expect(status.text).toContain("Pending requests: 0");
    }
  });

  it.each([false, true])("validates subscriber corruption (selected: %s)", async (selected) => {
    const row = subscriber({ mode: "once" });
    const { db } = openOpenClawStateDatabase({ env });
    // Corruption is a cold-storage fixture, not an external update to a live cached row.
    const insert = db.prepare(
      `INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES ('device-pair', '${DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE}', ?, ?, 1, NULL)`,
    );
    insert.run(notifySubscriberStoreKey(row), selected ? "{" : JSON.stringify(row));
    insert.run("unrelated", "{");
    if (selected) {
      await expect(notifyCommand(api, "status")).rejects.toMatchObject({
        code: "PLUGIN_STATE_CORRUPT",
        operation: "lookup",
      });
      return;
    }
    const status = await notifyCommand(api, "status");
    expect(status.text).toContain("Mode: once");
    expect(status.text).toContain("Subscribers: 2");
  });

  it("propagates count failures without retrying enumeration", async () => {
    const failure = new Error("count unavailable");
    const entries = vi.fn(async () => []);
    const api = createApi(undefined, <T>(options: OpenKeyedStoreOptions) => ({
      ...openStore<T>(options),
      count: async () => {
        throw failure;
      },
      entries,
    }));
    await expect(
      handleNotifyCommand({
        api,
        ctx: { channel: "telegram", senderId: "chat-123" },
        action: "status",
      }),
    ).rejects.toBe(failure);
    expect(entries).not.toHaveBeenCalled();
  });

  it.each(["subscriber command from another API", "persisted seen receipt on restart"] as const)(
    "sleeps with empty notifier state and observes a later %s",
    async (addition) => {
      const { clock, gateway: gatewayScheduler, scheduler: initialScheduler } = createClock();
      let scheduler = initialScheduler;
      const warn = vi.spyOn(api.logger, "warn");
      const seenStore = openStore<NotifySeenRequest>({
        namespace: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_NAMESPACE,
        maxEntries: DEVICE_PAIR_NOTIFY_SEEN_REQUEST_MAX_ENTRIES,
        defaultTtlMs: DEVICE_PAIR_NOTIFY_MAX_SEEN_AGE_MS,
      });
      try {
        startPairingNotifier(api, scheduler);
        await clock.advanceBy(10_000);
        await expect(Promise.all(storage.takeStoreReads())).resolves.toEqual([[], []]);
        expect(listDevicePairingMock).not.toHaveBeenCalled();
        expect(gatewayScheduler.nextWakeAtMs).toBeNull();
        await clock.advanceBy(20_000);
        expect(storage.takeStoreReads()).toEqual([]);
        expect(gatewayScheduler.nextWakeAtMs).toBeNull();

        const isSubscriberCommand = addition !== "persisted seen receipt on restart";
        if (isSubscriberCommand) {
          const writerApi = createApi(undefined, storage.openKeyedStore);
          await notifyCommand(writerApi, "once");
          setPendingRequests({});
        } else {
          await scheduler.stop();
          await seenStore.register(notifyRequestStoreKey("request-1"), {
            requestId: "request-1",
            notifiedAtMs: 1_000,
          });
          scheduler = createTestPluginServiceScheduler(gatewayScheduler);
          startPairingNotifier(api, scheduler);
        }

        await clock.advanceBy(10_000);

        expect(warn).not.toHaveBeenCalled();
        expect(listDevicePairingMock).toHaveBeenCalledTimes(1);
        expect(sendText).toHaveBeenCalledTimes(isSubscriberCommand ? 1 : 0);
        if (isSubscriberCommand) {
          expect(sendText).toHaveBeenCalledWith(
            expect.objectContaining({ text: expect.stringContaining("ID: request-1") }),
          );
        } else {
          await expect(seenStore.entries()).resolves.toEqual([]);
        }
      } finally {
        await scheduler.stop();
      }
    },
  );

  it.each([false, true])(
    "does not cache an empty read across another API's committed arm (lost reply: %s)",
    async (lostReply) => {
      const { clock, scheduler } = createClock();
      const captured = createDeferred<void>();
      const release = createDeferred<void>();
      let holdRead = true;
      api = createApi(sendText, <T>(options: OpenKeyedStoreOptions) => {
        const store = storage.openKeyedStore<T>(options);
        if (options.namespace === DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE) {
          const entries = store.entries.bind(store);
          store.entries = async () => {
            const result = await entries();
            if (holdRead) {
              holdRead = false;
              captured.resolve();
              await release.promise;
            }
            return result;
          };
        }
        return store;
      });
      const writerApi = createApi(undefined, <T>(options: OpenKeyedStoreOptions) => {
        const store = storage.openKeyedStore<T>(options);
        if (lostReply && options.namespace === DEVICE_PAIR_NOTIFY_SUBSCRIBER_NAMESPACE) {
          const register = store.register.bind(store);
          store.register = async (...args) => {
            await register(...args);
            throw new Error("committed arm reply unavailable");
          };
        }
        return store;
      });
      startPairingNotifier(api, scheduler);
      const firstPoll = clock.advanceBy(10_000);
      try {
        await storage.waitFor(captured.promise);
        const arm = notifyCommand(writerApi, "once");
        if (lostReply) {
          await expect(arm).rejects.toThrow("committed arm reply unavailable");
        } else {
          await arm;
        }
        setPendingRequests({});
        release.resolve();
        await firstPoll;
        expect(listDevicePairingMock).not.toHaveBeenCalled();
        await clock.advanceBy(10_000);
        expect(sendText).toHaveBeenCalledTimes(1);
        await storage.requestStored("request-1");
      } finally {
        release.resolve();
        await firstPoll;
        await scheduler.stop();
      }
    },
  );

  it("defers the first notify poll and keeps one in flight across service recreation", async () => {
    vi.useFakeTimers();
    const firstPoll = createDeferred<Awaited<ReturnType<typeof listDevicePairingMock>>>();
    const failedPoll = createDeferred<Awaited<ReturnType<typeof listDevicePairingMock>>>();
    listDevicePairingMock
      .mockImplementationOnce(() => firstPoll.promise)
      .mockImplementationOnce(() => failedPoll.promise)
      .mockResolvedValue({ pending: [], paired: [] });
    await notifyCommand(api, "on");
    let service = createNotifier(api);

    service.start();
    expect(listDevicePairingMock).not.toHaveBeenCalled();

    await storage.advanceAndRead();
    expect(listDevicePairingMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);

    const retired = vi.fn();
    const stopping = Promise.resolve(service.stop()).then(retired);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retired).not.toHaveBeenCalled();
    expect(listDevicePairingMock).toHaveBeenCalledTimes(1);

    await Promise.all(storage.takeStoreReads());
    firstPoll.resolve({ pending: [], paired: [] });
    await stopping;
    service = createNotifier(createApi(undefined, storage.openKeyedStore));
    service.start();
    await storage.advanceAndRead();
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(listDevicePairingMock).toHaveBeenCalledTimes(2);

    await Promise.all(storage.takeStoreReads());
    failedPoll.reject(new Error("poll failed"));
    await vi.advanceTimersByTimeAsync(0);
    await storage.advanceAndRead();
    expect(listDevicePairingMock).toHaveBeenCalledTimes(3);

    await service.stop();
  });

  it("delivers each request once when a service reload interrupts a slow send", async () => {
    vi.useFakeTimers();
    const { pending: firstSend, entered: sendEntered } = delayedSender(async () => delivery);
    const firstRequest = { displayName: "First device", ts: 1 };
    const secondRequest = { requestId: "request-2", displayName: "Second device", ts: 2 };
    await notifyCommand(api, "on");
    setPendingRequests(firstRequest);
    let service = createNotifier(api);

    service.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await sendEntered.promise;

    const retired = vi.fn();
    const stopping = Promise.resolve(service.stop()).then(retired);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(retired).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledTimes(1);

    firstSend.resolve(delivery);
    await storage.requestStored("request-1");
    await stopping;
    service = createNotifier(createApi(sendText, storage.openKeyedStore));
    service.start();
    await vi.advanceTimersByTimeAsync(10_000);

    await Promise.all(storage.takeStoreReads());
    setPendingRequests(firstRequest, secondRequest);
    await vi.advanceTimersByTimeAsync(10_000);
    await storage.requestStored("request-2");
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendText.mock.calls[1]?.[0]).toMatchObject({
      to: "chat-123",
      text: expect.stringContaining("ID: request-2"),
    });

    await service.stop();
  });

  it.each([false, true])(
    "preserves in-flight subscriber changes (same-ms re-arm: %s)",
    async (rearm) => {
      freezeTime();
      const { pending: firstSend, entered: sendEntered } = delayedSender();
      const senderId = rearm ? "chat-123" : "old-chat";
      await notifyCommand(api, rearm ? "once" : "on", { senderId });
      setPendingRequests(...(rearm ? [{}, { requestId: "request-2", ts: 2_001 }] : [{}]));
      const service = createNotifier(api);

      try {
        service.start();
        await vi.advanceTimersByTimeAsync(10_000);
        await storage.waitFor(sendEntered.promise);

        if (rearm) {
          vi.setSystemTime(1_000);
          await notifyCommand(api, "once");
        } else {
          await notifyCommand(api, "off", { senderId });
          await notifyCommand(api, "on", { senderId: "new-chat" });
        }
        firstSend.resolve({ ...delivery, to: senderId });
        await storage.requestStored("request-1");
        await vi.advanceTimersByTimeAsync(0);
        await service.stop();
        expect(sendText).toHaveBeenCalledTimes(1);

        if (rearm) {
          await expect(
            openSubscriberStore().lookup(notifySubscriberStoreKey({ to: senderId })),
          ).resolves.toMatchObject({ to: senderId, mode: "once", addedAtMs: 1_000 });
        } else {
          await expect(openSubscriberStore().entries()).resolves.toMatchObject([
            {
              key: notifySubscriberStoreKey({ to: "new-chat" }),
              value: { to: "new-chat", mode: "persistent" },
            },
          ]);
        }
      } finally {
        firstSend.resolve(delivery);
        await service.stop();
      }
    },
  );

  it("keeps the request boundary at the current millisecond when re-armed", async () => {
    freezeTime();
    await notifyCommand(api, "once");
    const key = notifySubscriberStoreKey({ to: "chat-123" });
    const first = await openSubscriberStore().lookup(key);
    await notifyCommand(api, "once");
    const second = await openSubscriberStore().lookup(key);

    expect(first).toMatchObject({ addedAtMs: 1_000, armId: expect.any(String) });
    expect(second).toMatchObject({ addedAtMs: 1_000, armId: expect.any(String) });
    expect(second?.armId).not.toBe(first?.armId);

    setPendingRequests({ requestId: "request-same-ms", ts: 1_000 });
    const service = createNotifier(api);
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await storage.requestStored("request-same-ms");

      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("ID: request-same-ms") }),
      );
    } finally {
      await service.stop();
    }
  });

  it("delivers a persisted one-shot without an arm nonce to only the first new request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const sendText = vi.fn(async () => ({ channel: "telegram", to: "chat-123" }));
    const storage = observeNotifyStorage();
    const api = createApi(sendText, storage.openKeyedStore);
    api.logger.warn = storage.pollFailed;
    const subscriber: NotifySubscription = { to: "chat-123", mode: "once", addedAtMs: 1_000 };
    await openSubscriberStore().register(notifySubscriberStoreKey(subscriber), subscriber);
    listDevicePairingMock.mockResolvedValue({
      pending: [
        {
          requestId: "request-1",
          deviceId: "device-1",
          publicKey: "public-key-1",
          ts: 1_001,
        },
        {
          requestId: "request-2",
          deviceId: "device-2",
          publicKey: "public-key-2",
          ts: 1_002,
        },
      ],
      paired: [],
    });
    const service = createNotifier(api);

    try {
      service.start();
      await vi.advanceTimersByTimeAsync(10_000);
      await storage.requestStored("request-1");

      expect(sendText).toHaveBeenCalledTimes(1);
      expect(sendText).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("ID: request-1") }),
      );
      await expect(openSubscriberStore().entries()).resolves.toStrictEqual([]);
    } finally {
      await service.stop();
      await storage.settlePoll("request-1");
    }
  });

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    const subscriber: NotifySubscription = {
      to: "chat-123",
      accountId: "telegram-default",
      messageThreadId: 271,
      mode: "persistent",
      addedAtMs: 1,
    };
    await openSubscriberStore().register(notifySubscriberStoreKey(subscriber), subscriber);
    const api = createApi();

    const status = await notifyCommand(api, "status", {
      accountId: "telegram-default",
      messageThreadId: "271",
    });

    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");

    await notifyCommand(api, "off", { accountId: "telegram-default", messageThreadId: "271" });

    await expect(openSubscriberStore().entries()).resolves.toStrictEqual([]);
  });

  it("does not remove a different persisted subscriber when notify fields contain pipes", async () => {
    const firstSubscriber: NotifySubscription = {
      to: "chat|123",
      accountId: "acct",
      mode: "persistent",
      addedAtMs: 1,
    };
    const secondSubscriber: NotifySubscription = {
      to: "chat",
      accountId: "123|acct",
      mode: "persistent",
      addedAtMs: 2,
    };
    const store = openSubscriberStore();
    await store.register(notifySubscriberStoreKey(firstSubscriber), firstSubscriber);
    await store.register(notifySubscriberStoreKey(secondSubscriber), secondSubscriber);
    const api = createApi();

    await notifyCommand(api, "off", { senderId: "chat", accountId: "123|acct" });

    const status = await notifyCommand(api, "status", { senderId: "chat", accountId: "123|acct" });
    expect(status.text).toContain("Pair request notifications: disabled for this chat.");

    await expect(openSubscriberStore().entries()).resolves.toMatchObject([
      {
        key: notifySubscriberStoreKey(firstSubscriber),
        value: firstSubscriber,
      },
    ]);
  });
});
