// Covers native approval runtime delivery and resolution.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { createChannelNativeApprovalRuntime as createChannelNativeApprovalRuntimeRaw } from "./approval-native-runtime.js";

const hoisted = vi.hoisted(() => ({
  callGatewayLeastPrivilege: vi.fn(async () => ({ ok: true })),
  createOperatorApprovalsGatewayClient: vi.fn(
    async (params: { onHelloOk?: (hello: unknown) => void }) => {
      queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" }));
      return {
        request: vi.fn(async () => ({ ok: true })),
        stop: vi.fn(),
      };
    },
  ),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({ ready: true, aborted: false })),
}));

vi.mock("../gateway/call.js", () => ({
  callGatewayLeastPrivilege: hoisted.callGatewayLeastPrivilege,
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: hoisted.createOperatorApprovalsGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: hoisted.startGatewayClientWhenEventLoopReady,
}));

const execRequest = {
  id: "approval-1",
  request: { command: "uname -a" },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

const approvalRuntimes: Array<ReturnType<typeof createChannelNativeApprovalRuntimeRaw>> = [];
type RuntimeOptions = Parameters<typeof createChannelNativeApprovalRuntimeRaw>[0];

function createChannelNativeApprovalRuntime(params: Partial<RuntimeOptions>) {
  const runtime = createChannelNativeApprovalRuntimeRaw({
    label: "test/native-runtime",
    clientDisplayName: "Test",
    cfg: {},
    isConfigured: () => true,
    shouldHandle: () => true,
    buildPendingContent: () => "pending exec",
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: plannedTarget.target.to,
      target: { chatId: plannedTarget.target.to },
    }),
    deliverTarget: async () => null,
    finalizeResolved: async () => {},
    ...params,
  });
  approvalRuntimes.push(runtime);
  return runtime;
}

function dmAdapter(
  overrides: Partial<ChannelApprovalNativeAdapter> = {},
  notifyOriginWhenDmOnly = false,
): ChannelApprovalNativeAdapter {
  return {
    describeDeliveryCapabilities: () => ({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: notifyOriginWhenDmOnly,
      supportsApproverDmSurface: true,
      notifyOriginWhenDmOnly,
    }),
    resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(approvalRuntimes.splice(0).map((runtime) => runtime.stop()));
  hoisted.callGatewayLeastPrivilege.mockClear();
  hoisted.createOperatorApprovalsGatewayClient.mockClear();
  hoisted.startGatewayClientWhenEventLoopReady.mockClear();
  vi.useRealTimers();
});

describe("createChannelNativeApprovalRuntime", () => {
  it.each(["dedupe", "delivery-failure"] as const)(
    "resolves successful deliveries after %s",
    async (mode) => {
      vi.useFakeTimers();
      const dedupe = mode === "dedupe";
      const prepareTarget = vi.fn(
        async ({ plannedTarget }: { plannedTarget: { target: { to: string } } }) => ({
          dedupeKey: dedupe ? "shared-dm" : plannedTarget.target.to,
          target: { channelId: dedupe ? "shared-dm" : plannedTarget.target.to },
        }),
      );
      const deliverTarget = vi.fn(
        async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => {
          if (!dedupe && preparedTarget.channelId === "approver-1") {
            throw new Error("boom");
          }
          return { channelId: preparedTarget.channelId };
        },
      );
      const onDuplicateSkipped = vi.fn();
      const onDeliveryError = vi.fn();
      const finalizeResolved = vi.fn(async () => undefined);
      const runtime = createChannelNativeApprovalRuntime({
        nowMs: () => 0,
        nativeAdapter: dmAdapter(
          dedupe ? { resolveOriginTarget: async () => ({ to: "origin-room" }) } : {},
          dedupe,
        ),
        prepareTarget,
        deliverTarget,
        onDuplicateSkipped,
        onDeliveryError,
        finalizeResolved,
      });
      await runtime.handleRequested(execRequest);
      await runtime.handleResolved({ id: execRequest.id, decision: "allow-once", ts: 1 });
      expect(prepareTarget).toHaveBeenCalledTimes(2);
      expect(deliverTarget).toHaveBeenCalledTimes(dedupe ? 1 : 2);
      expect(onDuplicateSkipped).toHaveBeenCalledTimes(dedupe ? 1 : 0);
      expect(onDeliveryError).toHaveBeenCalledTimes(dedupe ? 0 : 1);
      expect(finalizeResolved).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ entries: [{ channelId: dedupe ? "shared-dm" : "approver-2" }] }),
      );
    },
  );

  it("selects and expires system-agent approval targets through the native lifecycle", async () => {
    const deliverTarget = vi.fn().mockResolvedValue({ chatId: "123", messageId: "m1" });
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "default",
      eventKinds: ["system-agent"],
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
        }),
        resolveOriginTarget: () => ({ to: "123" }),
      },
      buildPendingContent: vi.fn().mockResolvedValue({ text: "pending" }),
      deliverTarget,
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "system-agent:native-1",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "delegation-1",
      },
      createdAtMs: 0,
      expiresAtMs: 2_000,
    });

    expect(deliverTarget).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
    await runtime.handleExpired("system-agent:native-1");
    expect(finalizeExpired).toHaveBeenCalledOnce();
  });

  it("passes the resolved approval kind and pending content through native delivery hooks", async () => {
    const describeDeliveryCapabilities = vi.fn().mockReturnValue({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
    });
    const resolveApproverDmTargets = vi
      .fn()
      .mockImplementation(({ approvalKind, accountId }) => [
        { to: `${approvalKind}:${accountId}` },
      ]);
    const buildPendingContent = vi.fn().mockResolvedValue("pending plugin");
    const prepareTarget = vi.fn().mockReturnValue({
      dedupeKey: "dm:plugin:secondary",
      target: { chatId: "plugin:secondary" },
    });
    const deliverTarget = vi
      .fn()
      .mockResolvedValue({ chatId: "plugin:secondary", messageId: "m1" });
    const finalizeResolved = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "secondary",
      eventKinds: ["exec", "plugin"] as const,
      nativeAdapter: {
        describeDeliveryCapabilities,
        resolveApproverDmTargets,
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget,
      deliverTarget,
      finalizeResolved,
    });

    await runtime.handleRequested({
      id: "opaque-request-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    });
    await runtime.handleResolved({
      id: "opaque-request-1",
      decision: "allow-once",
      ts: 1,
    });

    const pendingCall = mockCallArg(buildPendingContent);
    expect(requireRecord(pendingCall.request).id).toBe("opaque-request-1");
    expect(pendingCall.approvalKind).toBe("plugin");
    expect(typeof pendingCall.nowMs).toBe("number");

    const prepareCall = mockCallArg(prepareTarget);
    expect(prepareCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(requireRecord(prepareCall.request).id).toBe("opaque-request-1");
    expect(prepareCall.approvalKind).toBe("plugin");
    expect(prepareCall.pendingContent).toBe("pending plugin");

    const deliverCall = mockCallArg(deliverTarget);
    expect(deliverCall.plannedTarget).toEqual({
      surface: "approver-dm",
      target: { to: "plugin:secondary" },
      reason: "preferred",
    });
    expect(deliverCall.preparedTarget).toEqual({ chatId: "plugin:secondary" });
    expect(requireRecord(deliverCall.request).id).toBe("opaque-request-1");
    expect(deliverCall.approvalKind).toBe("plugin");
    expect(deliverCall.pendingContent).toBe("pending plugin");

    const capabilitiesCall = mockCallArg(describeDeliveryCapabilities);
    expect(capabilitiesCall.cfg).toEqual({});
    expect(capabilitiesCall.accountId).toBe("secondary");
    expect(capabilitiesCall.approvalKind).toBe("plugin");
    expect(requireRecord(capabilitiesCall.request).id).toBe("opaque-request-1");

    const dmTargetsCall = mockCallArg(resolveApproverDmTargets);
    expect(dmTargetsCall.cfg).toEqual({});
    expect(dmTargetsCall.accountId).toBe("secondary");
    expect(dmTargetsCall.approvalKind).toBe("plugin");
    expect(requireRecord(dmTargetsCall.request).id).toBe("opaque-request-1");

    const resolvedCall = mockCallArg(finalizeResolved);
    expect(requireRecord(resolvedCall.request).id).toBe("opaque-request-1");
    expect(requireRecord(resolvedCall.resolved)).toEqual({
      id: "opaque-request-1",
      decision: "allow-once",
      ts: 1,
    });
    expect(resolvedCall.entries).toEqual([{ chatId: "plugin:secondary", messageId: "m1" }]);
  });

  it("honors the deprecated approval kind compatibility override", async () => {
    const resolveApprovalKind = vi.fn().mockReturnValue("exec");
    const buildPendingContent = vi.fn().mockResolvedValue("pending");
    const runtime = createChannelNativeApprovalRuntime({
      resolveApprovalKind,
      buildPendingContent,
      prepareTarget: async () => null,
      deliverTarget: async () => null,
    });

    const request = {
      id: "legacy-owned-id",
      request: { title: "Plugin approval", description: "Allow access" },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    } as const;
    const normalizedRequest = { ...request, approvalKind: "plugin" as const };
    await runtime.handleRequested(request);

    expect(resolveApprovalKind).toHaveBeenCalledWith(normalizedRequest);
    expect(buildPendingContent).toHaveBeenCalledWith(
      expect.objectContaining({ request: normalizedRequest, approvalKind: "exec" }),
    );
  });

  it("sends route notices over least-privilege gateway calls", async () => {
    const runtime = createChannelNativeApprovalRuntime({
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
      cfg: { gateway: { auth: { token: "configured-token" } } },
      nativeAdapter: dmAdapter(
        {
          resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
          resolveApproverDmTargets: async () => [{ to: "user:owner" }],
        },
        true,
      ),
      deliverTarget: async () => ({ chatId: "user:owner", messageId: "m1" }),
    });

    await runtime.start();
    try {
      await runtime.handleRequested({
        id: "approval-route-notice",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: Date.now() + 60_000,
      });
    } finally {
      await runtime.stop();
    }

    expect(hoisted.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { gateway: { auth: { token: "configured-token" } } },
        method: "send",
        clientName: "gateway-client",
        mode: "backend",
        params: {
          channel: "slack",
          to: "channel:C123",
          accountId: "default",
          threadId: "1712345678.123456",
          message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
          idempotencyKey: "approval-route-notice:approval-route-notice",
        },
      }),
    );
  });

  it("runs expiration through the shared runtime factory", async () => {
    vi.useFakeTimers();
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      channel: "telegram",
      channelLabel: "Telegram",
      nowMs: Date.now,
      nativeAdapter: dmAdapter({
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      }),
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "req-1",
      request: { command: "echo hi" },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(finalizeExpired).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        request: expect.objectContaining({ id: "req-1" }),
        entries: [{ chatId: "owner", messageId: "m1" }],
      }),
    );
  });
});
