import { streamSimpleAnthropic } from "@openclaw/ai/internal/anthropic";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import type { OpenClawPluginApi, ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { MINIMAX_OAUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMinimaxProviders } from "./provider-registration.js";

const m31Model: Model<"anthropic-messages"> = {
  id: "MiniMax-M3.1-Flash-Preview",
  name: "MiniMax M3.1 Flash Preview",
  provider: "minimax",
  api: "anthropic-messages",
  baseUrl: "https://api.minimaxi.com/anthropic",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 131072,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

vi.mock("./oauth.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth.runtime.js")>()),
  loginMiniMaxPortalOAuth: vi.fn(async () => ({
    access: "minimax-oauth-access-token",
    refresh: "minimax-oauth-refresh-token",
    expires: Date.now() + 60_000,
    resourceUrl: "https://api.minimax.io/anthropic",
    tokenEndpoint: "https://account.minimax.io/oauth2/token",
  })),
}));

const minimaxProviderPlugin = {
  register: registerMinimaxProviders,
};

const globalApi = "https://api.minimax.io/anthropic";
const cnApi = "https://api.minimaxi.com/anthropic";
const currentCnApi = "https://api.minimax.cn/anthropic";
const globalToken = "https://account.minimax.io/oauth2/token";
const cnToken = "https://account.minimaxi.com/oauth2/token";
const modelConfig = (baseUrl: string, provider = "minimax-portal") => ({
  models: { providers: { [provider]: { baseUrl, models: [] } } },
});
function catalogContext(overrides: Partial<ProviderCatalogContext> = {}): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    ...overrides,
  };
}

async function registeredProviders(baseUrl?: string) {
  const { providers } = await registerProviderPlugin({
    plugin:
      baseUrl === undefined
        ? minimaxProviderPlugin
        : {
            register: (api: OpenClawPluginApi) =>
              registerMinimaxProviders({
                ...api,
                runtime: {
                  ...api.runtime,
                  config: {
                    ...api.runtime.config,
                    current: () => modelConfig(baseUrl),
                  },
                },
              }),
          },
    id: "minimax",
    name: "MiniMax Provider",
  });
  return {
    apiProvider: requireRegisteredProvider(providers, "minimax"),
    portalProvider: requireRegisteredProvider(providers, "minimax-portal"),
  };
}

function captureFastModel(
  provider: ProviderPlugin,
  fastMode: boolean | "ultrafast" | (() => boolean | "ultrafast"),
) {
  const model = { ...m31Model, id: "MiniMax-M2.7", provider: provider.id };
  let resolvedId = "";
  const stream = provider.wrapStreamFn?.({
    provider: provider.id,
    modelId: model.id,
    extraParams: { fastMode },
    streamFn: (resolved) => {
      resolvedId = resolved.id ?? "";
      return createAssistantMessageEventStream();
    },
  });
  return () => {
    void stream?.(model, { messages: [] }, {});
    return resolvedId;
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

describe("minimax provider hooks", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "MiniMax-M3" }] })),
    );
  });

  it.each([
    {
      name: "environment endpoint with blank configuration",
      baseUrl: " ",
      host: "https://api.minimaxi.com",
      expectedEndpoint: "https://api.minimaxi.com/anthropic/v1/models",
    },
    {
      name: "OpenAI-compatible Global configuration ahead of the CN environment",
      baseUrl: "https://api.minimax.io/v1",
      api: "openai-completions" as const,
      host: "https://api.minimaxi.com",
      expectedEndpoint: "https://api.minimax.io/v1/models",
    },
  ])(
    "keeps API catalog discovery on the $name",
    async ({ baseUrl, host, api, expectedEndpoint }) => {
      const expectedBaseUrl = baseUrl.trim() || `${host}/anthropic`;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
        input === expectedEndpoint
          ? Response.json({ data: [{ id: "MiniMax-M3" }] })
          : new Response(null, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { apiProvider } = await registeredProviders();
      const result = await runProviderCatalog({
        ...catalogContext(),
        provider: apiProvider,
        config: {
          models: {
            providers: {
              minimax: { baseUrl, ...(api ? { api } : {}), models: [] },
              "minimax-portal": {
                baseUrl: "https://other-account.example.com/anthropic",
                models: [],
              },
            },
          },
        },
        env: { MINIMAX_API_HOST: host },
        resolveProviderApiKey: () => ({
          apiKey: "MINIMAX_API_KEY",
          discoveryApiKey: "selected-api-key",
          profileId: "minimax:selected",
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(expectedEndpoint);
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-api-key")).toBe(api ? null : "selected-api-key");
      expect(headers.get("authorization")).toBe(api ? "Bearer selected-api-key" : null);
      expect(result).toMatchObject({
        provider: {
          baseUrl: expectedBaseUrl,
          api: api ?? "anthropic-messages",
          authHeader: true,
          apiKey: "MINIMAX_API_KEY",
          models: [expect.objectContaining({ id: "MiniMax-M3" })],
        },
        outcomes: [{ provider: "minimax", profileId: "minimax:selected", status: "ready" }],
      });
    },
  );

  it("keeps explicit portal API keys ahead of stored OAuth profiles", async () => {
    const fetchMock = vi.mocked(fetch);
    const { portalProvider } = await registeredProviders();

    const catalog = await portalProvider.catalog?.run(
      catalogContext({
        config: {
          models: {
            providers: {
              "minimax-portal": { baseUrl: globalApi, apiKey: "explicit-key", models: [] },
            },
          },
        },
        resolveProviderAuth: () => ({
          apiKey: MINIMAX_OAUTH_MARKER,
          discoveryApiKey: "oauth-token",
          mode: "oauth",
          source: "profile",
        }),
      }),
    );

    const provider = catalog && "provider" in catalog ? catalog.provider : undefined;
    expect(provider?.apiKey).toBe("explicit-key");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.minimax.io/anthropic/v1/models");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("explicit-key");
    expect(headers.get("authorization")).toBeNull();
  });

  it.each([undefined, "oauth"] as const)(
    "keeps selected profile mode %s coherent through the shared catalog wrapper",
    async (mode) => {
      const fetchMock = vi.mocked(fetch);
      const { portalProvider } = await registeredProviders();
      const legacyToken = mode === undefined;
      const apiKey = mode === "oauth" ? MINIMAX_OAUTH_MARKER : "MINIMAX_API_KEY";

      const result = await runProviderCatalog({
        provider: portalProvider,
        ...catalogContext(),
        resolveProviderApiKey: () => ({
          apiKey,
          discoveryApiKey: legacyToken ? undefined : "selected-profile-credential",
          profileId: "minimax-portal:selected",
          ...(mode ? { mode } : {}),
        }),
        resolveProviderAuth: () => ({
          apiKey: legacyToken ? apiKey : MINIMAX_OAUTH_MARKER,
          discoveryApiKey: legacyToken ? "selected-profile-credential" : "other-oauth-credential",
          mode: legacyToken ? "token" : "oauth",
          profileId: legacyToken ? "minimax-portal:selected" : "minimax-portal:other-oauth",
          source: "profile",
        }),
      });

      expect(result?.outcomes).toMatchObject([
        {
          provider: "minimax-portal",
          profileId: "minimax-portal:selected",
          status: "ready",
        },
      ]);
      const provider = result && "provider" in result ? result.provider : undefined;
      expect(provider?.apiKey).toBe(apiKey);
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("authorization")).toBe("Bearer selected-profile-credential");
    },
  );

  it.each([
    ["different profiles", "minimax-portal:selected", "minimax-portal:other", "token"],
    ["unknown profiles", undefined, undefined, undefined],
    ["different credential modes", "minimax-portal:selected", "minimax-portal:selected", "api_key"],
  ] as const)(
    "does not complete matching markers with %s",
    async (_name, selectedProfileId, resolvedProfileId, mode) => {
      const { portalProvider } = await registeredProviders();
      const result = await runProviderCatalog({
        provider: portalProvider,
        ...catalogContext(),
        resolveProviderApiKey: () => ({
          apiKey: "MINIMAX_OAUTH_TOKEN",
          profileId: selectedProfileId,
          mode,
        }),
        resolveProviderAuth: () => ({
          apiKey: "MINIMAX_OAUTH_TOKEN",
          discoveryApiKey: "other-profile-token",
          mode: "token",
          source: "profile",
          profileId: resolvedProfileId,
        }),
      });

      expect(result).toEqual({
        providers: {},
        outcomes: [
          {
            provider: "minimax-portal",
            profileId: selectedProfileId,
            status: "unavailable",
          },
        ],
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("defaults M3 thinking on while keeping M2.x thinking off by default", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();

    for (const provider of [apiProvider, portalProvider]) {
      expect(
        provider.resolveThinkingProfile?.({ provider: provider.id, modelId: "MiniMax-M3" }),
      ).toMatchObject({ defaultLevel: "adaptive" });
    }
    expect(
      apiProvider.resolveThinkingProfile?.({ modelId: "MiniMax-M2.7" } as never),
    ).toMatchObject({
      defaultLevel: "off",
    });
  });

  it("discovers M3.1 with its mandatory five-level thinking profile on both auth routes", async () => {
    const { apiProvider, portalProvider } = await registeredProviders();
    for (const provider of [apiProvider, portalProvider]) {
      const catalog = await provider.staticCatalog?.run({ env: {}, config: {} } as never);
      const models =
        catalog && "providers" in catalog ? catalog.providers[provider.id]?.models : [];
      expect(models?.find((model) => model.id === "MiniMax-M3.1-Flash-Preview")).toEqual(
        expect.objectContaining({
          id: "MiniMax-M3.1-Flash-Preview",
          input: ["text", "image"],
          contextWindow: 1_000_000,
          reasoning: true,
          compat: { codeMode: "preferred" },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      );
      expect(
        provider.resolveThinkingProfile?.({ modelId: "MiniMax-M3.1-Flash-Preview" } as never),
      ).toEqual({
        levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
        defaultLevel: "max",
      });
      expect(
        provider.resolveDynamicModel?.({
          provider: provider.id,
          modelId: "minimax-m3.1-flash-preview",
          providerConfig: {},
        } as never),
      ).toMatchObject({ id: "MiniMax-M3.1-Flash-Preview", api: "anthropic-messages" });
    }
  });

  it.each([
    [undefined, "max", undefined, 500],
    ["low", "low", m31Model.maxTokens, 500],
    ["high", "high", 128, 500],
    ["adaptive", "max", 128, undefined],
  ] as const)(
    "sends M3.1 effort %s as %s (model cap: %s, request cap: %s)",
    async (thinkingLevel, effort, modelMaxTokens, requestedMaxTokens) => {
      const { apiProvider, portalProvider } = await registeredProviders();
      for (const provider of [apiProvider, portalProvider]) {
        for (const hook of ["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const) {
          const model = {
            ...m31Model,
            provider: provider.id,
            api:
              hook === "wrapStreamFn" ? "anthropic-messages" : "openclaw-provider-simple:synthetic",
          };
          if (modelMaxTokens === undefined) {
            Reflect.deleteProperty(model, "maxTokens");
          } else {
            model.maxTokens = modelMaxTokens;
          }
          let payload: unknown;
          const wrapped = provider[hook]?.({
            provider: provider.id,
            modelId: model.id,
            sourceApi: "anthropic-messages",
            thinkingLevel,
            streamFn: (runtimeModel, context, options) =>
              streamSimpleAnthropic(
                { ...runtimeModel, api: "anthropic-messages" },
                context,
                options,
              ),
          });
          if (!wrapped) {
            throw new Error(`MiniMax did not register ${hook}`);
          }
          const stream = await wrapped(
            model,
            {
              messages: [
                { role: "user", content: "Hi", timestamp: 0 },
                makeAgentAssistantMessage({
                  api: "anthropic-messages",
                  provider: provider.id,
                  model: m31Model.id,
                  content: [
                    {
                      type: "thinking",
                      thinking: "Earlier reasoning.",
                      thinkingSignature: "synthetic-thinking-signature",
                    },
                    { type: "text", text: "Hello." },
                  ],
                  timestamp: 1,
                }),
                { role: "user", content: "Continue.", timestamp: 2 },
              ],
            },
            {
              apiKey: "synthetic-minimax-key",
              maxTokens: requestedMaxTokens,
              reasoning: thinkingLevel === "adaptive" ? undefined : thinkingLevel,
              // M3.1 uses adaptive effort; manual budgets must not disable signed replay.
              thinkingBudgets:
                modelMaxTokens === m31Model.maxTokens
                  ? { low: 0, medium: 0, high: 0, max: 0 }
                  : undefined,
              onPayload: (value) => {
                payload = value;
                throw new Error("stop before network");
              },
            },
          );
          expect(await stream.result()).toMatchObject({ errorMessage: "stop before network" });
          expect(payload).toMatchObject({
            thinking: { type: "adaptive" },
            max_tokens: Math.min(
              requestedMaxTokens ?? m31Model.maxTokens,
              modelMaxTokens ?? m31Model.maxTokens,
            ),
            output_config: { effort },
          });
          expect(payload).not.toHaveProperty("thinking.budget_tokens");
          expect(payload).toHaveProperty("messages.1.content.0", {
            type: "thinking",
            thinking: "Earlier reasoning.",
            signature: "synthetic-thinking-signature",
          });
        }
      }
    },
  );

  it("preserves M3.1 output configuration and resolves effort per call", async () => {
    const { apiProvider } = await registeredProviders();
    const payload: Record<string, unknown> = { output_config: { format: { type: "json_schema" } } };
    const wrapped = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: m31Model.id,
      thinkingLevel: "high",
      streamFn: (model, _context, options) => {
        options?.onPayload?.(payload, model);
        return createAssistantMessageEventStream();
      },
    });
    for (const reasoning of ["low", "max", undefined] as const) {
      void wrapped?.(m31Model, { messages: [] }, { reasoning });
      expect(payload.output_config).toEqual({
        format: { type: "json_schema" },
        effort: reasoning ?? "high",
      });
    }
  });

  it("keeps M3.1 request shaping away from openai-completions", async () => {
    const { apiProvider } = await registeredProviders();
    const payload = { thinking: { type: "disabled" } };
    const wrapped = apiProvider.wrapStreamFn?.({
      provider: "minimax",
      modelId: m31Model.id,
      thinkingLevel: "low",
      streamFn: (model, _context, options) => {
        options?.onPayload?.(payload, model);
        return createAssistantMessageEventStream();
      },
    });
    void wrapped?.({ ...m31Model, api: "openai-completions" }, { messages: [] }, {});
    expect(payload).toEqual({ thinking: { type: "disabled" } });
  });

  it("owns ultrafast stream wrapping for MiniMax transports", async () => {
    let fastMode: boolean | "ultrafast" = "ultrafast";
    const { apiProvider, portalProvider } = await registeredProviders();
    const apiModel = captureFastModel(apiProvider, fastMode);
    const portalModel = captureFastModel(portalProvider, () => fastMode);
    expect(apiModel()).toBe("MiniMax-M2.7-highspeed");
    expect(portalModel()).toBe("MiniMax-M2.7-highspeed");
    fastMode = false;
    expect(portalModel()).toBe("MiniMax-M2.7");
  });

  it("prefers minimax-portal oauth when resolving MiniMax usage auth", async () => {
    const { apiProvider } = await registeredProviders();
    const resolveOAuthToken = vi.fn(async (params?: { provider?: string }) =>
      params?.provider === "minimax-portal" ? { token: "portal-oauth-token" } : null,
    );
    const resolveApiKeyCandidatesFromConfigAndStore = vi.fn(async () => []);

    await expect(
      apiProvider.resolveUsageAuth?.({
        provider: "minimax",
        config: {},
        env: {},
        resolveOAuthToken,
        resolveApiKeyCandidatesFromConfigAndStore,
      } as never),
    ).resolves.toEqual({ token: "portal-oauth-token" });

    expect(resolveOAuthToken).toHaveBeenCalledWith({ provider: "minimax-portal" });
    expect(resolveApiKeyCandidatesFromConfigAndStore).not.toHaveBeenCalled();
  });

  it("uses the configured MiniMax base URL for usage snapshots", async () => {
    const { apiProvider } = await registeredProviders();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://api.minimax.io/v1/token_plan/remains");
      return Response.json({
        data: {
          current_interval_total_count: 100,
          current_interval_usage_count: 98,
        },
      });
    });

    const result = await apiProvider.fetchUsageSnapshot?.({
      provider: "minimax",
      config: modelConfig(globalApi, "minimax"),
      env: {},
      token: "key",
      timeoutMs: 5000,
      fetchFn: fetchFn as typeof fetch,
    } as never);

    expect(result?.windows).toEqual([{ label: "5h", usedPercent: 2, resetAt: undefined }]);
  });

  it("writes api and authHeader into the MiniMax portal OAuth config patch", async () => {
    const { portalProvider } = await registeredProviders();
    const oauthMethod = portalProvider.auth.find((method) => method.id === "oauth");

    if (!oauthMethod) {
      throw new Error("expected minimax portal oauth auth method");
    }

    const assertCurrent = vi.fn();
    const result = await oauthMethod.run({
      prompter: {
        progress() {
          return { stop() {} };
        },
        note: vi.fn(async () => undefined),
      },
      openUrl: vi.fn(async () => undefined),
      assertCurrent,
    } as never);

    const { loginMiniMaxPortalOAuth } = await import("./oauth.runtime.js");
    expect(vi.mocked(loginMiniMaxPortalOAuth)).toHaveBeenCalledWith(
      expect.objectContaining({ assertCurrent }),
    );

    expect(result?.configPatch?.models?.providers?.["minimax-portal"]).toEqual({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      authHeader: true,
      models: [],
    });
    expect(result?.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      provider: "minimax-portal",
      authFlow: "device-code",
      tokenEndpoint: "https://account.minimax.io/oauth2/token",
    });
  });

  it.each([
    [cnApi, globalApi, cnToken],
    [currentCnApi, globalApi, cnToken],
    [globalApi, undefined, globalToken],
    ["https://proxy.example.com/anthropic", undefined, globalToken],
  ] as const)(
    "refreshes expired portal OAuth at its issuing endpoint (base URL %s)",
    async (baseUrl, runtimeBaseUrl, tokenEndpoint) => {
      const { portalProvider } = await registeredProviders(runtimeBaseUrl ?? baseUrl);
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const fetchMock = vi.fn(async () =>
        Response.json({
          status: "success",
          access_token: "fresh-access",
          refresh_token: "rotated-refresh",
          expired_in: 7200,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        portalProvider.refreshOAuth?.(
          expiredPortalCredential(tokenEndpoint),
          runtimeBaseUrl ? modelConfig(baseUrl) : undefined,
        ),
      ).resolves.toEqual({
        ...expiredPortalCredential(tokenEndpoint),
        access: "fresh-access",
        refresh: "rotated-refresh",
        expires: 1_700_007_200_000,
      });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
      expect(url).toBe(tokenEndpoint);
      expect(Object.fromEntries(new URLSearchParams(init.body))).toEqual({
        grant_type: "refresh_token",
        client_id: "78257093-7e40-4613-99e0-527b14b39113",
        refresh_token: "stored-refresh",
      });
    },
  );

  it.each([
    ["missing issuing endpoint", globalApi, undefined, undefined],
    ["Global credential moved to CN", cnApi, globalApi, globalToken],
    ["Global credential moved to current CN host", currentCnApi, globalApi, globalToken],
    ["CN credential moved to Global", globalApi, cnApi, cnToken],
  ] as const)(
    "refuses portal OAuth refresh before any request: %s",
    async (_case, baseUrl, runtimeBaseUrl, tokenEndpoint) => {
      const { portalProvider } = await registeredProviders(runtimeBaseUrl ?? baseUrl);
      const fetchMock = vi.fn(async () =>
        Response.json({ status: "success", access_token: "unexpected-access", expired_in: 7200 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        portalProvider.refreshOAuth?.(
          expiredPortalCredential(tokenEndpoint),
          runtimeBaseUrl ? modelConfig(baseUrl) : undefined,
        ),
      ).rejects.toThrow("openclaw models auth login --provider minimax-portal");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

function expiredPortalCredential(tokenEndpoint: string | undefined) {
  return {
    type: "oauth" as const,
    provider: "minimax-portal",
    access: "expired-access",
    refresh: "stored-refresh",
    expires: 1,
    authFlow: "device-code",
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
  };
}
