// Google Meet realtime tests cover real local command-pair substitute processes.
import { spawn as spawnChildProcess, type ChildProcess } from "node:child_process";
import { on, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createLocalMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";

const tempDirs: string[] = [];
const spawnedChildren: ChildProcess[] = [];

type MeetRealtimeAudioSpawn = NonNullable<
  Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]
>;

const GOOGLE_MEET_ENGINE_BINDINGS = {
  platform: {
    displayName: "Google Meet",
    logScope: "[google-meet]",
    sessionIdPrefix: "google-meet",
  },
  consultAgent: async () => ({ text: "" }),
  tools: [],
  handleToolCall: async () => {},
};

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createTransport(
  script: string,
  overrides: Partial<Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]> = {},
) {
  return createLocalMeetingRealtimeAudioTransport({
    inputCommand: [process.execPath, script, "capture"],
    outputCommand: [process.execPath, script, "play"],
    bargeInRmsThreshold: 10,
    bargeInPeakThreshold: 10,
    bargeInCooldownMs: 1,
    logger: makeLogger(),
    logScope: "[google-meet]",
    spawn: makeRecordingSpawn(),
    ...overrides,
  });
}

function spyKill(child: ChildProcess) {
  const kill = child.kill.bind(child);
  return vi.spyOn(child, "kill").mockImplementation((signal) => kill(signal));
}

function expectSignals(spy: ReturnType<typeof spyKill>, signals: NodeJS.Signals[]) {
  for (const signal of signals) {
    expect(spy.mock.calls.filter(([sent]) => sent === signal)).toHaveLength(1);
  }
}

function mockTransport() {
  return {
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: vi.fn(async () => {}),
    writeOutput: vi.fn(async () => {}),
    clearOutput: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies MeetingRealtimeAudioTransport;
}

function mockTranscriptionSession(connected = false) {
  return {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => connected),
  };
}

function transcriptionProvider(
  createSession: RealtimeTranscriptionProviderPlugin["createSession"],
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-transcribe",
    autoSelectOrder: 1,
    resolveConfig: ({ rawConfig }) => rawConfig,
    isConfigured: () => true,
    createSession,
  };
}

function mockVoiceBridge() {
  return {
    connect: vi.fn(async () => {}),
    sendAudio: vi.fn(),
    sendUserMessage: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    triggerGreeting: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}

function voiceProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"],
  id = "openai",
): RealtimeVoiceProviderPlugin {
  return { id, label: "Test voice provider", isConfigured: () => true, createBridge };
}

function engineOptions(
  config: ReturnType<typeof resolveGoogleMeetConfig>,
  meetingSessionId: string,
) {
  return {
    config,
    fullConfig: {},
    runtime: {} as never,
    ...GOOGLE_MEET_ENGINE_BINDINGS,
    meetingSessionId,
    logger: makeLogger(),
  };
}

function writeCommand(source: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-bridge-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "bridge-command.mjs");
  writeFileSync(scriptPath, source, { mode: 0o755 });
  return scriptPath;
}

function writeBridgeCommand(): string {
  return writeCommand(
    [
      "process.on('SIGTERM', () => {",
      "  process.exit(0);",
      "});",
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
}

function writeSigtermResistantBridgeCommand(): string {
  return writeCommand(
    [
      "process.stderr.write(`starting:${process.argv[2]}\\n`);",
      "process.stdin.resume();",
      "setTimeout(() => {",
      "  process.on('SIGTERM', () => {",
      "    process.stderr.write('sigterm\\n');",
      "  });",
      "  process.stderr.write(`ready:${process.argv[2]}\\n`);",
      "}, 50);",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
}

async function waitForBridgeReady(
  stderr: NonNullable<ChildProcess["stderr"]>,
  role: "capture" | "play",
  signal: AbortSignal,
): Promise<void> {
  let pending = "";
  for await (const [chunk] of on(stderr, "data", { signal, close: ["end", "close"] })) {
    const lines = (pending + String(chunk)).split("\n");
    pending = lines.pop() ?? "";
    if (lines.includes(`ready:${role}`)) {
      return;
    }
  }
  throw new Error(`Bridge ${role} closed before readiness`);
}

function makeRecordingSpawn(): MeetRealtimeAudioSpawn {
  return (command, args, options) => {
    const child = spawnChildProcess(command, args, options);
    spawnedChildren.push(child);
    return child as ReturnType<MeetRealtimeAudioSpawn>;
  };
}

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

describe("local Meet realtime transport process stream errors", () => {
  it("stops the engine when input fails during provider setup", async () => {
    const bridgeScript = writeBridgeCommand();
    let finishConnect = () => {};
    const connectGate = new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
    const sttSession = mockTranscriptionSession();
    sttSession.connect.mockReturnValue(connectGate);
    const provider = transcriptionProvider(() => sttSession);
    const logger = makeLogger();
    const transport = createTransport(bridgeScript, {
      inputCommand: [path.join(path.dirname(bridgeScript), "missing-capture")],
      logger,
    });
    const config = resolveGoogleMeetConfig({
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    const engineResult = startMeetingAgentRealtimeEngine({
      ...engineOptions(config, "meet-startup-failure"),
      logger,
      providers: [provider],
      transport,
    }).then(
      () => new Error("Expected Google Meet engine startup to fail"),
      (error: unknown) => error,
    );
    const inputProcess = spawnedChildren[1];
    if (!inputProcess) {
      throw new Error("Expected Google Meet transport to spawn an input child process");
    }

    await once(inputProcess, "error");
    await vi.waitFor(() => {
      expect(sttSession.close).toHaveBeenCalledTimes(1);
    });
    finishConnect();

    await expect(engineResult).resolves.toEqual(
      new Error("Google Meet audio transport stopped during transcription provider setup"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[google-meet] audio input command failed:"),
    );
    await transport.dispose();
  });

  it("contains a forced local command-pair stdout stream error through bridge stop", async () => {
    const bridgeScript = writeBridgeCommand();
    const sttSession = mockTranscriptionSession(true);
    const provider = transcriptionProvider(() => sttSession);
    const logger = makeLogger();

    const config = resolveGoogleMeetConfig({
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    const transport = createTransport(bridgeScript, {
      bargeInRmsThreshold: config.chrome.bargeInRmsThreshold,
      bargeInPeakThreshold: config.chrome.bargeInPeakThreshold,
      bargeInCooldownMs: config.chrome.bargeInCooldownMs,
      logger,
    });
    const handle = await startMeetingAgentRealtimeEngine({
      ...engineOptions(config, "meet-1"),
      logger,
      providers: [provider],
      transport,
    });
    const [outputProcess, inputProcess] = spawnedChildren;
    if (!inputProcess || !outputProcess) {
      throw new Error("Expected Google Meet bridge to spawn input and output child processes");
    }
    const inputClosed = once(inputProcess, "close");
    const outputClosed = once(outputProcess, "close");
    const inputKillSpy = spyKill(inputProcess);
    const outputKillSpy = spyKill(outputProcess);

    inputProcess.stdout?.destroy(new Error("EPIPE from real bridge input stdout"));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    inputProcess.stderr?.destroy(new Error("duplicate stderr EPIPE"));

    await Promise.all([inputClosed, outputClosed]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stdout failed: EPIPE from real bridge input stdout",
    );
    expect(handle.getHealth().bridgeClosed).toBe(true);
    expect(sttSession.close).toHaveBeenCalledTimes(1);
    expectSignals(inputKillSpy, ["SIGTERM"]);
    expectSignals(outputKillSpy, ["SIGTERM"]);
  });

  it.skipIf(process.platform === "win32")(
    "waits for SIGTERM-resistant bridge processes and shares the stop promise",
    async ({ signal: testSignal }) => {
      const bridgeScript = writeSigtermResistantBridgeCommand();
      const transport = createTransport(bridgeScript);
      const [outputProcess, inputProcess] = spawnedChildren;
      if (!inputProcess || !outputProcess || !inputProcess.stderr || !outputProcess.stderr) {
        throw new Error("Expected Google Meet bridge to spawn stderr-backed child processes");
      }
      await Promise.all([
        waitForBridgeReady(inputProcess.stderr, "capture", testSignal),
        waitForBridgeReady(outputProcess.stderr, "play", testSignal),
      ]);
      const inputKillSpy = spyKill(inputProcess);
      const outputKillSpy = spyKill(outputProcess);

      const startedAt = Date.now();
      const firstStop = transport.stop();
      const secondStop = transport.stop();

      expect(secondStop).toBe(firstStop);
      await firstStop;
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      expect(elapsedMs).toBeLessThan(5_000);
      expectSignals(inputKillSpy, ["SIGTERM", "SIGKILL"]);
      expectSignals(outputKillSpy, ["SIGTERM", "SIGKILL"]);
    },
  );
});

describe("Google Meet bidi realtime engine cleanup", () => {
  it("preserves the configured realtime agent through provider startup", async () => {
    let bridgeRequest: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const isConfigured = vi.fn(({ agentId }) => agentId === "molty");
    const bridge = mockVoiceBridge();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      isConfigured,
      createBridge: (request) => {
        bridgeRequest = request;
        return bridge;
      },
    };
    const transport = mockTransport();
    const config = resolveGoogleMeetConfig({
      realtime: { strategy: "bidi", provider: "openai", agentId: "molty" },
    });
    const fullConfig = {
      agents: { entries: { helper: {}, molty: {} } },
    } as never;

    const handle = await startMeetingRealtimeEngine({
      ...engineOptions(config, "meet-routed-agent"),
      fullConfig,
      providers: [provider],
      transport,
    });

    expect(isConfigured).toHaveBeenCalledWith(expect.objectContaining({ agentId: "molty" }));
    expect(bridgeRequest?.agentId).toBe("molty");
    await handle.stop();
  });

  it("stops the audio transport when the provider bridge closes unexpectedly", async () => {
    let closeBridge: ((reason: "completed" | "error") => void) | undefined;
    const bridge = mockVoiceBridge();
    const provider = voiceProvider((params) => {
      closeBridge = params.onClose;
      return bridge;
    });
    const stop = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    const transport = { ...mockTransport(), stop, dispose };
    const handle = await startMeetingRealtimeEngine({
      ...engineOptions(
        resolveGoogleMeetConfig({ realtime: { strategy: "bidi", provider: "openai" } }),
        "meet-unexpected-close",
      ),
      providers: [provider],
      transport,
    });

    closeBridge?.("completed");
    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
    });
    expect(handle.getHealth().bridgeClosed).toBe(true);
  });

  it("retries only the unsettled transport teardown phase", async () => {
    const stopError = new Error("transport stop failed");
    let closeBridge: ((reason: "completed" | "error") => void) | undefined;
    const bridge = mockVoiceBridge();
    bridge.close.mockImplementation(() => closeBridge?.("completed"));
    const provider = voiceProvider((params) => {
      closeBridge = params.onClose;
      return bridge;
    });
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const dispose = vi.fn(async () => {});
    const transport = { ...mockTransport(), stop, dispose };
    const handle = await startMeetingRealtimeEngine({
      ...engineOptions(
        resolveGoogleMeetConfig({ realtime: { strategy: "bidi", provider: "openai" } }),
        "meet-stop-retry",
      ),
      providers: [provider],
      transport,
    });

    await expect(handle.stop()).rejects.toBe(stopError);
    await expect(handle.stop()).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledOnce();
    expect(bridge.close).toHaveBeenCalledOnce();
  });
});

describe("Google Meet realtime model logs", () => {
  it("keeps a whole code point when a provider id crosses the log boundary", async () => {
    const prefix = "a".repeat(179);
    const providerId = `${prefix}😀tail`;
    const bridge = mockVoiceBridge();
    const provider = voiceProvider(() => bridge, providerId);
    const transport = mockTransport();
    const logger = makeLogger();
    const handle = await startMeetingRealtimeEngine({
      ...engineOptions(
        resolveGoogleMeetConfig({ realtime: { strategy: "native", provider: providerId } }),
        "long-provider-log",
      ),
      logger,
      providers: [provider],
      transport,
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`provider=${prefix} model=provider-default`),
    );
    await handle.stop();
  });
});
