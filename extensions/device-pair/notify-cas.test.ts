import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createTestPluginServiceScheduler,
  createTestPluginApi,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifySubscriberStoreKey, type NotifySubscription } from "./notify-state.js";

vi.mock("openclaw/plugin-sdk/device-bootstrap", () => ({
  listDevicePairing: async () => ({
    pending: [{ requestId: "request-1", deviceId: "device-1", ts: 2_000 }],
    paired: [],
  }),
}));

import { startPairingNotifier } from "./notify.js";
type SubscriberStore = PluginStateKeyedStore<NotifySubscription>;

describe("device-pair notify CAS", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function createHarness(delivered: NotifySubscription) {
    let current: NotifySubscription | undefined = delivered;
    let revision = 0;
    const snapshot = () => ({ value: current, comparison: String(revision) });
    const replace = (value: NotifySubscription | undefined) => {
      current = value;
      revision++;
    };
    const sendText = vi.fn(async () => ({ channel: "telegram", to: delivered.to }));
    const loadAdapter = vi.fn(async () => ({ sendText }));
    const observe = vi.fn(async () => snapshot());
    const compareAndApply = vi.fn<NonNullable<SubscriberStore["compareAndApply"]>>(
      async (_key, comparison, intent) => {
        if (comparison !== String(revision)) {
          return { status: "conflict", current: snapshot() };
        }
        if (intent.operation === "delete" && intent.action === "delete" && current) {
          replace(undefined);
          return { status: "applied" };
        }
        return { status: "unchanged" };
      },
    );
    const subscriberStore: Pick<
      SubscriberStore,
      "observe" | "compareAndApply" | "deleteIf" | "entries"
    > = {
      observe,
      compareAndApply,
      deleteIf: vi.fn(async () => false),
      entries: vi.fn(async () => [
        { key: notifySubscriberStoreKey(delivered), value: delivered, createdAt: 1_000 },
      ]),
    };
    const recordSeen = vi.fn(async () => {});
    const warn = vi.fn();
    const api = createTestPluginApi({
      logger: { info() {}, warn, error() {} },
      runtime: {
        state: {
          openKeyedStore: () => ({ entries: async () => [], register: recordSeen }),
          openKeyedStoreV2: () => subscriberStore,
        },
        channel: { outbound: { loadAdapter } },
      } as never,
    });
    return {
      subscriberStore,
      observe,
      compareAndApply,
      sendText,
      loadAdapter,
      recordSeen,
      warn,
      snapshot,
      replace,
      async poll() {
        const scheduler = createTestPluginServiceScheduler();
        try {
          startPairingNotifier(api, scheduler);
          await vi.advanceTimersByTimeAsync(10_000);
        } finally {
          await scheduler.stop();
        }
      },
    };
  }

  const delivered: NotifySubscription = {
    to: "chat-123",
    mode: "once",
    addedAtMs: 1_000,
    armId: "arm-1",
  };

  it.each([
    { label: "changed storage metadata", current: delivered },
    { label: "new arm", current: { ...delivered, armId: "arm-2" } },
    { label: "removed arm", current: undefined },
  ])("preserves $label after a delivery conflict without recapturing it", async ({ current }) => {
    const harness = createHarness(delivered);
    delete harness.subscriberStore.deleteIf;
    harness.sendText.mockImplementationOnce(async () => {
      harness.replace(current);
      return { channel: "telegram", to: delivered.to };
    });

    await harness.poll();

    expect(harness.sendText).toHaveBeenCalledTimes(1);
    expect(harness.observe).toHaveBeenCalledTimes(1);
    expect(harness.observe.mock.invocationCallOrder[0]).toBeLessThan(
      harness.sendText.mock.invocationCallOrder[0]!,
    );
    expect(harness.compareAndApply).toHaveBeenCalledTimes(1);
    expect(harness.snapshot().value).toEqual(current);
    expect(harness.recordSeen).toHaveBeenCalledTimes(1);
  });

  it.each`
    label                                 | current                                                                            | sends
    ${"disabled"}                         | ${undefined}                                                                       | ${false}
    ${"rearmed after the request"}        | ${{ ...delivered, addedAtMs: 3_000 }}                                              | ${false}
    ${"persistent with a current thread"} | ${{ ...delivered, mode: "persistent", addedAtMs: 3_000, messageThreadId: "0271" }} | ${true}
  `("uses the $label row after adapter preparation", async ({ current, sends }) => {
    const harness = createHarness({ ...delivered, messageThreadId: 271 });
    harness.loadAdapter.mockImplementationOnce(async () => {
      harness.replace(current);
      return { sendText: harness.sendText };
    });

    await harness.poll();

    expect(harness.sendText).toHaveBeenCalledTimes(sends ? 1 : 0);
    if (sends) {
      expect(harness.sendText).toHaveBeenCalledWith(
        expect.objectContaining({ to: current?.to, threadId: "0271" }),
      );
    }
    expect(harness.compareAndApply).not.toHaveBeenCalled();
    expect(harness.recordSeen).toHaveBeenCalledTimes(sends ? 1 : 0);
    expect(harness.snapshot().value).toEqual(current);
  });

  it.each(["sendText", "observe", "compareAndApply"] as const)(
    "retains the one-shot after rejected %s without retrying or recording success",
    async (operation) => {
      const harness = createHarness(delivered);
      harness[operation].mockRejectedValueOnce(new Error("outcome unavailable"));

      await harness.poll();

      expect(harness.sendText).toHaveBeenCalledTimes(operation === "observe" ? 0 : 1);
      expect(harness.observe).toHaveBeenCalledTimes(1);
      expect(harness.compareAndApply).toHaveBeenCalledTimes(
        operation === "compareAndApply" ? 1 : 0,
      );
      expect(harness.warn).toHaveBeenCalledWith(expect.stringContaining("outcome unavailable"));
      expect(harness.recordSeen).not.toHaveBeenCalled();
      expect(harness.snapshot().value).toEqual(delivered);
    },
  );
});
