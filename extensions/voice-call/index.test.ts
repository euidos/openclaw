import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import type { OpenClawPluginServiceContextV2 } from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import type { CallRecord } from "./src/types.js";

let runtimeStub: VoiceCallRuntime;
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type TestGatewayHandler = (ctx: {
  params: Record<string, unknown>;
  client?: { internal?: { pluginRuntimeOwnerId?: string } };
  respond: ReturnType<typeof vi.fn>;
}) => Promise<void>;

type Registered = {
  methods: Map<string, unknown>;
  methodScopes: Map<string, string | undefined>;
  tools: unknown[];
  service?: Parameters<OpenClawPluginApi["registerService"]>[0];
  cli?: Parameters<OpenClawPluginApi["registerCli"]>[0];
};
type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};
type RespondCall = [
  ok: boolean,
  payload?: Record<string, unknown>,
  error?: {
    code?: unknown;
    message?: unknown;
  },
];

function captureStdout() {
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return {
    output: () => output,
    restore: () => writeSpy.mockRestore(),
  };
}

function createRuntimeStub(callId = "call-1"): VoiceCallRuntime {
  const call = createCallRecord({ callId });
  return {
    config: {
      toNumber: "+15550001234",
      realtime: { enabled: false },
    } as VoiceCallRuntime["config"],
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall: vi.fn(async () => ({ callId, success: true })),
      continueCall: vi.fn(async () => ({
        success: true,
        transcript: "hello",
      })),
      speak: vi.fn(async () => ({ success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      endCall: vi.fn(async () => ({ success: true })),
      getCall: vi.fn((id: string) => (id === callId ? call : undefined)),
      getCallByProviderCallId: vi.fn(() => undefined),
      getCallFromMemoryOrStore: vi.fn(async (id: string) => (id === callId ? call : undefined)),
      getActiveCalls: vi.fn(() => [call]),
      getCallHistory: vi.fn(async () => []),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {
      speakRealtime: vi.fn(() => ({ success: false, error: "No active realtime bridge for call" })),
    } as unknown as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

function createCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

function createPrivateCallRecord(): CallRecord {
  return createCallRecord({
    metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
    processedEventIds: ["evt-1"],
    sessionKey: "agent:main:voice:call-1",
    transcript: [
      {
        timestamp: Date.UTC(2026, 4, 2, 9, 1, 0),
        speaker: "user",
        text: "private call transcript",
        isFinal: true,
      },
    ],
  });
}

function createServiceContext(): OpenClawPluginServiceContextV2 {
  return {
    config: {},
    stateDir: os.tmpdir(),
    logger: noopLogger,
    scheduler: createTestPluginServiceScheduler(),
  };
}

function setup(
  config: Record<string, unknown>,
  toolContext: Record<string, unknown> = {},
): Registered {
  const methods = new Map<string, unknown>();
  const methodScopes = new Map<string, string | undefined>();
  const tools: unknown[] = [];
  let service: Registered["service"];
  let cli: Registered["cli"];
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    pluginConfig: config,
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: (method: string, handler: unknown, opts?: { scope?: string }) => {
      methods.set(method, handler);
      methodScopes.set(method, opts?.scope);
    },
    registerTool: (tool: unknown) =>
      tools.push(
        typeof tool === "function"
          ? (tool as (context: Record<string, unknown>) => unknown)(toolContext)
          : tool,
      ),
    registerCli: (registrar) => {
      cli = registrar;
    },
    registerService: (registeredService) => {
      service = registeredService;
    },
  });
  plugin.register(api);
  return { methods, methodScopes, tools, service, cli };
}

async function setupActive(
  config: Record<string, unknown>,
  toolContext: Record<string, unknown> = {},
): Promise<Registered> {
  const registered = setup(config, toolContext);
  await registered.service?.start(createServiceContext());
  return registered;
}

async function invokeGateway(
  methods: Registered["methods"],
  method: string,
  params: Record<string, unknown>,
  client?: Parameters<TestGatewayHandler>[0]["client"],
) {
  const respond = vi.fn();
  await (methods.get(method) as TestGatewayHandler | undefined)?.({ params, client, respond });
  return firstRespondCall(respond);
}

type Tool = {
  parameters: unknown;
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{
    details: { success?: boolean; found?: boolean; call?: { state?: string }; error?: unknown };
  }>;
};

async function activeTool(context: Record<string, unknown> = {}) {
  return (await setupActive({ provider: "mock" }, context)).tools[0] as Tool;
}

function twilioConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "twilio",
    fromNumber: "+15550001234",
    twilio: { accountSid: "AC123", authToken: "token" },
    ...overrides,
  };
}

function mockHistoricalCall(endedAt: number) {
  runtimeStub.manager.getCall = vi.fn(() => undefined);
  runtimeStub.manager.getCallByProviderCallId = vi.fn(() => undefined);
  runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () =>
    createCallRecord({
      providerCallId: "CA123",
      state: "completed",
      endReason: "completed",
      endedAt,
    }),
  );
}

function expectCliGatewayCall(method: string, params: unknown, timeout = "5000") {
  expect(callGatewayFromCliMock).toHaveBeenCalledWith(method, { json: true, timeout }, params, {
    progress: false,
  });
}

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as unknown as RespondCall;
}

function firstRuntimeConfig(): VoiceCallRuntime["config"] | undefined {
  const options = mockCall(vi.mocked(createVoiceCallRuntime))[0] as
    | { config?: VoiceCallRuntime["config"] }
    | undefined;
  return options?.config;
}

function expectRedactedVoiceCallStatus(value: unknown): void {
  expect(value).toEqual({
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
  });
}

async function registerVoiceCallCli(
  program: Command,
  pluginConfig: Record<string, unknown> = { provider: "mock" },
) {
  const registrar = setup(pluginConfig).cli;
  if (!registrar) {
    throw new Error("voice-call CLI registrar was not registered");
  }
  await registrar({ program, parentPath: [], config: {}, logger: noopLogger });
}

async function runVoiceCallCli(
  args: string[],
  pluginConfig: Record<string, unknown> = { provider: "mock" },
): Promise<string> {
  vi.stubEnv("OPENCLAW_CLI", "1");
  const program = new Command();
  const stdout = captureStdout();
  try {
    await registerVoiceCallCli(program, pluginConfig);
    await program.parseAsync(args, { from: "user" });
    return stdout.output();
  } finally {
    stdout.restore();
  }
}

describe("voice-call plugin", () => {
  beforeEach(() => {
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
    noopLogger.debug.mockClear();
    runtimeStub = createRuntimeStub();
    callGatewayFromCliMock.mockReset();
    callGatewayFromCliMock.mockRejectedValue(
      Object.assign(new Error("gateway transport failed"), {
        name: "GatewayTransportError",
        kind: "closed",
        connectionDetails: { url: "ws://127.0.0.1:18789" },
      }),
    );
    vi.mocked(createVoiceCallRuntime).mockReset();
    vi.mocked(createVoiceCallRuntime).mockImplementation(async () => runtimeStub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
  });

  it("defaults canonical plugin config to an enabled mock runtime", async () => {
    const { service } = setup({});

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(firstRuntimeConfig()).toMatchObject({
      enabled: true,
      provider: "mock",
    });
  });

  it("does not start the webhook runtime for CLI-only plugin loading", async () => {
    vi.stubEnv("OPENCLAW_CLI", "1");
    const { service } = setup({ provider: "mock" });

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  });

  it("reports degraded service health when provider setup is incomplete", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");
    const { service } = setup({ provider: "twilio" });
    const reportFailure = vi.fn();

    await service?.start({
      ...createServiceContext(),
      serviceHealth: { reportFailure, clearFailure: vi.fn() },
    });

    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    expect(noopLogger.error.mock.calls.flat().join("\n")).toContain(
      "Runtime not started: setup incomplete",
    );
    expect(noopLogger.error.mock.calls.flat().join("\n")).toContain("TWILIO_ACCOUNT_SID");
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("TWILIO_ACCOUNT_SID") }),
    );
  });

  it("registers Twilio configs with SecretRef auth tokens", async () => {
    const authToken = envRef("TWILIO_AUTH_TOKEN");
    const { service } = setup({
      enabled: true,
      provider: "twilio",
      fromNumber: "+15550001234",
      twilio: {
        accountSid: "AC123",
        authToken,
      },
    });

    await service?.start(createServiceContext());

    expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
    expect(firstRuntimeConfig()?.twilio?.authToken).toEqual(authToken);
  });

  it("still reports missing provider setup when a command needs the runtime", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");
    const { methods } = setup({ provider: "twilio" });
    const respond = await invokeGateway(methods, "voicecall.initiate", {
      message: "Hi",
      to: "+15550001234",
    });

    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    const [ok, payload, error] = respond;
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(String(error?.message)).toContain("TWILIO_ACCOUNT_SID");
  });

  it("registers voice call gateway methods with least-privilege scopes", () => {
    const { methodScopes } = setup({ provider: "mock" });

    for (const method of [
      "voicecall.initiate",
      "voicecall.start",
      "voicecall.continue",
      "voicecall.continue.start",
      "voicecall.speak",
      "voicecall.dtmf",
      "voicecall.end",
    ]) {
      expect(methodScopes.get(method)).toBe("operator.write");
    }
    expect(methodScopes.get("voicecall.continue.result")).toBe("operator.read");
    expect(methodScopes.get("voicecall.status")).toBe("operator.read");
  });

  it("preserves mode on legacy voicecall.start", async () => {
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.start", {
      dtmfSequence: "ww123456#",
      message: "Hi",
      mode: "conversation",
      to: "+15550001234",
    });
    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith("+15550001234", undefined, {
      dtmfSequence: "ww123456#",
      message: "Hi",
      mode: "conversation",
    });
    expect(respond[0]).toBe(true);
  });

  it("accepts per-call agent routing only from plugin runtime", async () => {
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(
      methods,
      "voicecall.start",
      { to: "+15550001234", agentId: "support" },
      { internal: { pluginRuntimeOwnerId: "google-meet" } },
    );

    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
      "+15550001234",
      undefined,
      expect.objectContaining({ agentId: "support" }),
    );
    expect(respond[0]).toBe(true);
  });

  it("rejects external per-call agent routing", async () => {
    const { methods } = setup({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.start", {
      to: "+15550001234",
      agentId: "spoofed",
    });

    expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
    expect(respond[2]?.code).toBe("INVALID_REQUEST");
  });

  it("returns redacted call status", async () => {
    const call = createPrivateCallRecord();
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => call);
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.status", { callId: "call-1" });
    const [ok, payload] = respond;
    expect(ok).toBe(true);
    expect(payload?.found).toBe(true);
    expectRedactedVoiceCallStatus(payload?.call);
  });

  it("returns redacted active call status list", async () => {
    const call = createPrivateCallRecord();
    runtimeStub.manager.getActiveCalls = vi.fn(() => [call]);
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.status", {});

    const [ok, payload] = respond;
    expect(ok).toBe(true);
    expect(payload?.found).toBe(true);
    const calls = (payload?.calls as unknown[] | undefined) ?? [];
    expect(calls).toHaveLength(1);
    expectRedactedVoiceCallStatus(calls[0]);
  });

  it("sends DTMF via voicecall.dtmf", async () => {
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.dtmf", {
      callId: "call-1",
      digits: "ww123#",
    });

    expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
    expect(respond).toEqual([true, { success: true }]);
  });

  it("does not fall back to one-shot TwiML speak when realtime-only speech is requested", async () => {
    runtimeStub.config.realtime.enabled = true;
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.speak", {
      allowTwimlFallback: false,
      callId: "call-1",
      message: "hello",
    });

    expect(runtimeStub.webhookServer["speakRealtime"]).toHaveBeenCalledWith("call-1", "hello");
    expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
    expect(respond).toEqual([
      true,
      { success: false, error: "No active realtime bridge for call" },
    ]);
  });

  it("routes tool speech through the active realtime bridge", async () => {
    runtimeStub.config.realtime.enabled = true;
    runtimeStub.manager.getCall = vi.fn(() => undefined);
    runtimeStub.manager.getCallByProviderCallId = vi.fn(() =>
      createCallRecord({ callId: "call-1", providerCallId: "CA123" }),
    );
    runtimeStub.webhookServer.speakRealtime = vi.fn(() => ({ success: true }));
    const tool = await activeTool();

    const result = await tool.execute("id", {
      action: "speak_to_user",
      callId: "CA123",
      message: "hello",
    });

    expect(runtimeStub.webhookServer["speakRealtime"]).toHaveBeenCalledWith("call-1", "hello");
    expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
    expect(result.details.success).toBe(true);
  });

  it("keeps the tool's classic speech fallback when no realtime bridge is active", async () => {
    runtimeStub.config.realtime.enabled = true;
    const tool = await activeTool();

    const result = await tool.execute("id", {
      action: "speak_to_user",
      callId: "call-1",
      message: "hello",
    });

    expect(runtimeStub.webhookServer["speakRealtime"]).toHaveBeenCalledWith("call-1", "hello");
    expect(runtimeStub.manager["speak"]).toHaveBeenCalledWith("call-1", "hello");
    expect(result.details.success).toBe(true);
  });

  it("reports ended call history when speaking to a stale call", async () => {
    mockHistoricalCall(Date.UTC(2026, 4, 2, 9, 18, 23));
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.speak", {
      callId: "CA123",
      message: "hello",
    });

    const [ok, , error] = respond;
    expect(ok).toBe(false);
    expect(error?.message).toContain("call is not active");
    expect(error?.message).toContain("last state=completed");
    expect(error?.message).toContain("endReason=completed");
    expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
  });

  it("reports stale call history with invalid ended timestamps", async () => {
    mockHistoricalCall(Number.POSITIVE_INFINITY);
    const { methods } = await setupActive({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.speak", {
      callId: "CA123",
      message: "hello",
    });

    const [ok, , error] = respond;
    expect(ok).toBe(false);
    expect(error?.message).toContain("call is not active");
    expect(error?.message).toContain("last state=completed");
    expect(error?.message).toContain("endReason=completed");
    expect(error?.message).not.toContain("endedAt=");
  });

  it.each([{ action: "initiate_call", message: "Hello" }, { message: "Hello" }])(
    "freezes invocation context for tool-created calls ($action)",
    async (params) => {
      const tool = await activeTool({
        agentId: "support",
        sessionKey: "agent:support:discord:channel:general",
      });

      await tool.execute("id", {
        ...params,
        to: "+15550001234",
        requesterSessionKey: "agent:spoofed:requester",
        sessionKey: "agent:support:voice:call-1",
      });

      expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
        "+15550001234",
        "agent:support:voice:call-1",
        expect.objectContaining({
          agentId: "support",
          message: "Hello",
          requesterSessionKey: "agent:support:discord:channel:general",
        }),
      );
    },
  );

  it("does not expose requester session identity to the model", () => {
    const { tools } = setup({ provider: "mock" });
    const tool = tools[0] as { parameters: unknown };

    expect(JSON.stringify(tool.parameters)).not.toContain("requesterSessionKey");
  });

  it("tool get_status uses the manager's persisted fallback", async () => {
    const completed = createCallRecord({
      callId: "call-1",
      providerCallId: "CA123",
      state: "completed",
      endReason: "completed",
      endedAt: Date.UTC(2026, 4, 2, 9, 18, 23),
    });
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => completed);
    const tool = await activeTool();
    const result = await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    });
    expect(runtimeStub.manager["getCallFromMemoryOrStore"]).toHaveBeenCalledWith("call-1");
    expect(result.details.found).toBe(true);
    expect(result.details.call?.state).toBe("completed");
  });

  it("tool get_status reports found:false when the call is neither active nor persisted", async () => {
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => undefined);
    const tool = await activeTool();
    const result = await tool.execute("id", {
      action: "get_status",
      callId: "call-1",
    });
    expect(result.details.found).toBe(false);
  });

  it("tool send_dtmf returns json payload", async () => {
    const tool = await activeTool();
    const result = await tool.execute("id", {
      action: "send_dtmf",
      callId: "call-1",
      digits: "ww123#",
    });
    expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
    expect(result.details.success).toBe(true);
  });

  it("legacy tool status without sid returns error payload", async () => {
    const tool = await activeTool();
    const result = await tool.execute("id", { mode: "status" });
    expect(String(result.details.error)).toContain("sid required");
  });

  it("CLI rejects invalid numeric options", async () => {
    const program = new Command();
    await registerVoiceCallCli(program);
    for (const port of ["nope", "Infinity", "3334.9"]) {
      await expect(
        program.parseAsync(["voicecall", "expose", "--port", port, "--mode", "off"], {
          from: "user",
        }),
      ).rejects.toThrow(/Invalid numeric value for --port/);
    }
    const tmpFile = path.join(os.tmpdir(), `voicecall-invalid-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, "{}\n", "utf8");
    try {
      for (const last of ["later", "Infinity", "1.5"]) {
        await expect(
          program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", last], {
            from: "user",
          }),
        ).rejects.toThrow(/Invalid numeric value for --last/);
      }
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("CLI latency summarizes turn metrics from JSONL", async () => {
    const tmpFile = path.join(os.tmpdir(), `voicecall-latency-${Date.now()}.jsonl`);
    fs.writeFileSync(
      tmpFile,
      [
        { metadata: { lastTurnLatencyMs: 100, lastTurnListenWaitMs: 70 } },
        { metadata: { lastTurnLatencyMs: 200, lastTurnListenWaitMs: 110 } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
      "utf8",
    );
    try {
      const printed = await runVoiceCallCli([
        "voicecall",
        "latency",
        "--file",
        tmpFile,
        "--last",
        "10",
      ]);
      expect(printed).toContain('"recordsScanned": 2');
      expect(printed).toContain('"p50Ms": 100');
      expect(printed).toContain('"p95Ms": 200');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it("CLI start delegates to the running gateway runtime", async () => {
    callGatewayFromCliMock.mockResolvedValueOnce({ callId: "gateway-call", initiated: true });

    const output = await runVoiceCallCli([
      "voicecall",
      "start",
      "--to",
      "+1",
      "--message",
      "Hello",
    ]);
    expectCliGatewayCall(
      "voicecall.start",
      { to: "+1", message: "Hello", mode: "conversation" },
      "35000",
    );
    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    expect(output).toContain('"callId": "gateway-call"');
  });

  it("responds with protocol errors for delegated gateway failures", async () => {
    const { methods } = setup({ provider: "mock" });
    const respond = await invokeGateway(methods, "voicecall.start", {});

    const [ok, payload, error] = respond;
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(error?.message).toBe("to required");
  });

  it("starts and polls delegated gateway continue operations", async () => {
    callGatewayFromCliMock
      .mockResolvedValueOnce({
        operationId: "op-1",
        status: "pending",
        pollTimeoutMs: 180000,
      })
      .mockResolvedValueOnce({
        operationId: "op-1",
        status: "completed",
        result: { success: true, transcript: "gateway hello" },
      });

    const output = await runVoiceCallCli(
      ["voicecall", "continue", "--call-id", "call-1", "--message", "Hello"],
      {
        provider: "mock",
        transcriptTimeoutMs: 120000,
        tts: { timeoutMs: 30000 },
      },
    );
    expectCliGatewayCall(
      "voicecall.continue.start",
      { callId: "call-1", message: "Hello" },
      "35000",
    );
    expectCliGatewayCall("voicecall.continue.result", { operationId: "op-1" }, "5000");
    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    expect(output).toContain('"transcript": "gateway hello"');
  });

  it("gateway continue operations return pending, completed, and failed results", async () => {
    let finishContinue: ((value: { success: true; transcript: string }) => void) | undefined;
    const continuePromise = new Promise<{ success: true; transcript: string }>((resolve) => {
      finishContinue = resolve;
    });
    runtimeStub.manager.continueCall = vi.fn(
      async () => await continuePromise,
    ) as VoiceCallRuntime["manager"]["continueCall"];
    const { methods } = await setupActive({
      provider: "mock",
      transcriptTimeoutMs: 120000,
      tts: { timeoutMs: 30000 },
    });
    const start = (message: string) =>
      invokeGateway(methods, "voicecall.continue.start", { callId: "call-1", message });
    const result = (operationId: unknown) =>
      invokeGateway(methods, "voicecall.continue.result", { operationId });
    const [, startPayload] = await start("Hello");
    expect(startPayload).toMatchObject({
      operationId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
      ),
      status: "pending",
      pollTimeoutMs: 180000,
    });
    expect(runtimeStub.manager["continueCall"]).toHaveBeenCalledWith("call-1", "Hello");
    const pendingCall = await result(startPayload?.operationId);
    expect(pendingCall[0]).toBe(true);
    expect(pendingCall[1]?.status).toBe("pending");

    finishContinue?.({ success: true, transcript: "gateway hello" });
    await continuePromise;
    const completedCall = await vi.waitFor(async () => {
      const call = await result(startPayload?.operationId);
      expect(call[1]?.status).toBe("completed");
      return call;
    });
    expect(completedCall[0]).toBe(true);
    expect(completedCall[1]?.result).toEqual({ success: true, transcript: "gateway hello" });
    expect(await result(startPayload?.operationId)).toEqual([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: "operation not found" },
    ]);

    runtimeStub.manager.continueCall = vi.fn(async () => ({
      success: false,
      error: "turn failed",
    })) as VoiceCallRuntime["manager"]["continueCall"];
    const [, failedStart] = await start("Try again");
    const failedCall = await vi.waitFor(async () => {
      const call = await result(failedStart?.operationId);
      expect(call[1]?.status).toBe("failed");
      return call;
    });
    expect(failedCall[0]).toBe(true);
    expect(failedCall[1]).toMatchObject({ status: "failed", error: "turn failed" });
  });

  it("CLI setup prints human-readable checks by default", async () => {
    const output = await runVoiceCallCli(
      ["voicecall", "setup"],
      twilioConfig({ publicUrl: "https://voice.example.com/voice/webhook" }),
    );
    expect(output).toContain("Voice Call setup: OK");
    expect(output).toContain("OK provider: Provider configured: twilio");
  });

  it("CLI setup preserves JSON output with --json", async () => {
    const output = await runVoiceCallCli(["voicecall", "setup", "--json"], twilioConfig());
    const parsed = JSON.parse(output) as {
      ok?: boolean;
      checks?: Array<{ id: string; ok: boolean }>;
    };
    expect(parsed.ok).toBe(false);
    const webhookExposure = parsed.checks?.find((check) => check.id === "webhook-exposure");
    expect(webhookExposure?.ok).toBe(false);
  });

  it("CLI setup rejects a local public webhook URL for Twilio", async () => {
    const output = await runVoiceCallCli(
      ["voicecall", "setup", "--json"],
      twilioConfig({ publicUrl: "http://127.0.0.1:3334/voice/webhook" }),
    );
    const parsed = JSON.parse(output) as {
      ok?: boolean;
      checks?: Array<{ id: string; ok: boolean; message: string }>;
    };
    expect(parsed.ok).toBe(false);
    const webhookExposure = parsed.checks?.find((check) => check.id === "webhook-exposure");
    expect(webhookExposure?.ok).toBe(false);
    expect(webhookExposure?.message).toContain("local/private");
  });

  it("CLI status stays read-only when the gateway is unavailable", async () => {
    const output = await runVoiceCallCli(["voicecall", "status", "--json"]);
    const parsed = JSON.parse(output) as {
      calls?: Array<{ callId?: string }>;
    };
    expect(parsed.calls).toEqual([]);
    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  });

  it("CLI status lists active calls through the running gateway runtime", async () => {
    callGatewayFromCliMock.mockResolvedValueOnce({
      found: true,
      calls: [{ callId: "gateway-call" }],
    });

    const output = await runVoiceCallCli(["voicecall", "status", "--json"]);
    const parsed = JSON.parse(output) as {
      calls?: Array<{ callId?: string }>;
    };
    expectCliGatewayCall("voicecall.status", undefined, "5000");
    expect(createVoiceCallRuntime).not.toHaveBeenCalled();
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls?.[0]?.callId).toBe("gateway-call");
  });

  it("CLI smoke dry-runs a live call unless --yes is passed", async () => {
    const output = await runVoiceCallCli(
      ["voicecall", "smoke", "--to", "+15550009999"],
      twilioConfig({ publicUrl: "https://voice.example.com/voice/webhook" }),
    );
    expect(output).toContain("live-call: dry run for +15550009999");
    expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
  });
});
