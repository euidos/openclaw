import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcodeAudioBufferToOpusMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeAudioBufferToOpusMock,
}));

import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";

function clearMinimaxAuthEnv() {
  vi.stubEnv("MINIMAX_API_KEY", undefined);
  vi.stubEnv("MINIMAX_OAUTH_TOKEN", undefined);
  vi.stubEnv("MINIMAX_CODE_PLAN_KEY", undefined);
  vi.stubEnv("MINIMAX_CODING_API_KEY", undefined);
}

function seedMinimaxPortalProfile(agentDir: string) {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "minimax-portal:test": { type: "token", provider: "minimax-portal", token: "portal-token" },
      },
    },
    agentDir,
    {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    },
  );
}

function useAuthState(prefix: string) {
  let stateDir: string;
  let agentDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), prefix));
    agentDir = path.join(stateDir, "agents", "main", "agent");
    await mkdir(agentDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    clearMinimaxAuthEnv();
    clearRuntimeAuthProfileStoreSnapshots();
  });
  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    await rm(stateDir, { recursive: true, force: true });
  });
  return () => agentDir;
}

describe("buildMinimaxSpeechProvider", () => {
  const provider = buildMinimaxSpeechProvider({
    isProviderAuthProfileConfigured,
    isProviderAuthProfileConfiguredAsync,
  });

  const { resolveConfig, parseDirectiveToken } = provider;
  if (!resolveConfig || !parseDirectiveToken) {
    throw new Error("MiniMax speech provider must expose config and directive hooks");
  }
  const resolveProviderConfig = (rawConfig: Record<string, unknown>) =>
    resolveConfig({ rawConfig, cfg: {}, timeoutMs: 30000 });

  describe("isConfigured", () => {
    const agentDir = useAuthState("openclaw-minimax-tts-auth-");

    it.each([false, true])(
      "reports configured=%s for portal profile availability",
      async (available) => {
        if (available) {
          seedMinimaxPortalProfile(agentDir());
        }
        await expect(
          provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 30000 }),
        ).resolves.toBe(available);
      },
    );
  });

  describe("resolveConfig", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads from providers.minimax in rawConfig", () => {
      const minimax = {
        baseUrl: "https://custom.api.com",
        model: "speech-01-turbo",
        voiceId: "Chinese (Mandarin)_Warm_Girl",
        speed: 1.5,
        vol: 2,
        pitch: 3,
      };
      expect(resolveProviderConfig({ providers: { minimax } })).toMatchObject(minimax);
    });

    it("keeps trusted MINIMAX_API_HOST fallback for TTS baseUrl", () => {
      vi.stubEnv("MINIMAX_API_HOST", "https://api.minimax.io/anthropic");
      vi.stubEnv("MINIMAX_TTS_MODEL", "speech-01-turbo");
      vi.stubEnv("MINIMAX_TTS_VOICE_ID", "Chinese (Mandarin)_Gentle_Boy");
      expect(resolveProviderConfig({})).toMatchObject({
        baseUrl: "https://api.minimax.io",
        model: "speech-01-turbo",
        voiceId: "Chinese (Mandarin)_Gentle_Boy",
      });
    });
  });

  describe("parseDirectiveToken", () => {
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };

    it.each([
      ["voice", "Chinese (Mandarin)_Warm_Girl", { voiceId: "Chinese (Mandarin)_Warm_Girl" }],
      ["model", "speech-01-turbo", { model: "speech-01-turbo" }],
      ["speed", "1.5", { speed: 1.5 }],
      ["vol", "10", { vol: 10 }],
      ["pitch", "-3", { pitch: -3 }],
    ])("parses %s=%s", (key, value, overrides) => {
      const result = parseDirectiveToken({ key, value, policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toBeUndefined();
      expect(result.overrides).toEqual(overrides);
    });

    it("warns on invalid speed", () => {
      const result = parseDirectiveToken({ key: "speed", value: "5.0", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.overrides).toBeUndefined();
    });

    it("returns handled=false for unknown keys", () => {
      expect(parseDirectiveToken({ key: "unknown_key", value: "whatever", policy }).handled).toBe(
        false,
      );
    });

    it.each([
      ["voice", "allowVoice"],
      ["model", "allowModelId"],
    ] as const)("suppresses %s when policy disallows %s", (key, flag) => {
      const result = parseDirectiveToken({
        key,
        value: "test",
        policy: { ...policy, [flag]: false },
      });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });
  });

  describe("synthesize", () => {
    const fetchMock = vi.fn<typeof fetch>();
    function synthesize(overrides: Partial<Parameters<typeof provider.synthesize>[0]> = {}) {
      return provider.synthesize({
        text: "Test",
        cfg: {},
        providerConfig: { apiKey: "sk-test" },
        target: "audio-file",
        timeoutMs: 30000,
        ...overrides,
      });
    }

    function mockAudioResponse(audio = "audio") {
      fetchMock.mockResolvedValueOnce(
        Response.json({ data: { audio: Buffer.from(audio).toString("hex") } }),
      );
    }
    const agentDir = useAuthState("openclaw-minimax-tts-synth-");

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
      transcodeAudioBufferToOpusMock.mockReset();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    const firstFetchInit = () => fetchMock.mock.calls[0]?.[1];

    function firstFetchBody(): unknown {
      const body = firstFetchInit()?.body;
      if (typeof body !== "string") {
        throw new Error("Expected MiniMax TTS fetch init body");
      }
      return JSON.parse(body);
    }

    it("transcodes MiniMax MP3 to Opus for voice-note targets", async () => {
      mockAudioResponse("fake-mp3-data");
      transcodeAudioBufferToOpusMock.mockResolvedValueOnce(Buffer.from("fake-opus-data"));

      const result = await synthesize({
        text: "Hello world",
        providerConfig: { apiKey: "sk-test", baseUrl: "https://api.minimaxi.com" },
        target: "voice-note",
      });

      expect(result).toEqual(
        expect.objectContaining({
          outputFormat: "opus",
          fileExtension: ".opus",
          voiceCompatible: true,
          audioBuffer: Buffer.from("fake-opus-data"),
        }),
      );
      expect(transcodeAudioBufferToOpusMock).toHaveBeenCalledWith({
        audioBuffer: Buffer.from("fake-mp3-data"),
        inputExtension: "mp3",
        tempPrefix: "tts-minimax-",
        timeoutMs: 30000,
      });
    });

    it("applies overrides", async () => {
      mockAudioResponse();

      await synthesize({
        providerOverrides: {
          model: "speech-01-turbo",
          voiceId: "custom_voice",
          speed: 1.5,
          vol: 1.5,
          pitch: 0.5,
        },
      });

      expect(firstFetchBody()).toMatchObject({
        model: "speech-01-turbo",
        voice_setting: { voice_id: "custom_voice", speed: 1.5, vol: 1.5, pitch: 0 },
      });
    });

    it("drops malformed voice settings before synthesis", async () => {
      mockAudioResponse();

      await synthesize({
        providerConfig: {
          apiKey: "sk-test",
          speed: 3,
          vol: -1,
          pitch: 20,
        },
      });

      expect(firstFetchBody()).toMatchObject({ voice_setting: { speed: 1, vol: 1, pitch: 0 } });
    });

    it("uses a MiniMax Token Plan env var when no API key is configured", async () => {
      process.env.MINIMAX_CODING_API_KEY = "sk-cp-env";
      mockAudioResponse();

      await synthesize({ text: "Token plan TTS", providerConfig: {} });

      expect(firstFetchInit()?.headers).toEqual({
        Authorization: "Bearer sk-cp-env",
        "Content-Type": "application/json",
      });
    });

    it("uses a minimax-portal auth profile before env API keys", async () => {
      process.env.MINIMAX_API_KEY = "sk-env";
      seedMinimaxPortalProfile(agentDir());
      mockAudioResponse();

      await synthesize({
        text: "Portal TTS",
        cfg: {
          models: {
            providers: {
              "minimax-portal": { baseUrl: "https://api.minimaxi.com/anthropic" },
            },
          },
        } as never,
        providerConfig: {},
      });

      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.minimaxi.com/v1/t2a_v2");
      expect(firstFetchInit()?.headers).toEqual({
        Authorization: "Bearer portal-token",
        "Content-Type": "application/json",
      });
    });

    it("does not send a request for a blank environment API key", async () => {
      process.env.MINIMAX_API_KEY = "   ";

      await expect(synthesize({ providerConfig: {} })).rejects.toThrow("MiniMax TTS auth missing");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("throws on API error with response body", async () => {
      fetchMock.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
      await expect(synthesize()).rejects.toThrow("MiniMax TTS API error (401): Unauthorized");
    });
  });
});
