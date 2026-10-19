/* @vitest-environment jsdom */

import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  type SystemAgentChatResult,
  type SystemAgentChatHistoryResult,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { hasSensitiveConfigData } from "../../components/config-form.shared.ts";
import { installSafeLocalStorageForTesting } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
  currentPluginHelpReference,
} from "./plugin-help.ts";

const plugin = { id: "example", name: "Example" };
const inferenceFailure = (message: string) =>
  new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    details: { code: "system_agent_inference_unavailable" },
  });
const reloadFailure = { configReload: { hotReloadStatus: "disabled" }, channels: {} };
const historyMethods = ["openclaw.chat", "openclaw.chat.history"];
type RequestArgs = [method: string, params: unknown, options?: { signal?: AbortSignal }];
type Context = ReturnType<typeof createContext>["context"];
const echoReply = (_method: string, params: { sessionId?: string }) =>
  Promise.resolve(chatReply(params.sessionId));
const setting = (path: string[], label: string, value: unknown, sensitive = false) => ({
  path,
  label,
  value,
  sensitive,
});
const ask = (context: Context, value: ReturnType<typeof setting>, target = plugin) =>
  createPluginHelpRequest(context, target)(value);
function historyRequest(
  read: () => Promise<SystemAgentChatHistoryResult>,
  send: (
    params: { sessionId?: string; message?: string },
    options?: { signal?: AbortSignal },
  ) => unknown = (params) => Promise.resolve(chatReply(params.sessionId)),
) {
  return vi.fn(
    (
      method: string,
      params: { sessionId?: string; message?: string },
      options?: { signal?: AbortSignal },
    ) => (method === "openclaw.chat.history" ? read() : send(params, options)),
  );
}
const text = (store: CustodianSessionStore) => store.messages.map((message) => message.text);
function chatReply<T extends string | undefined>(sessionId: T, reply = "Ready.") {
  return { sessionId, reply, action: "none" as const };
}
function connectStore(context: Context) {
  const store = new CustodianSessionStore();
  store.connect(context, "caretaker");
  return store;
}
function setupStore(
  request = vi.fn().mockResolvedValue(chatReply("plugin-help-session")),
  methods = ["openclaw.chat"],
  options: Parameters<typeof createContext>[2] = {},
  variant: Parameters<CustodianSessionStore["connect"]>[1] = "caretaker",
) {
  const harness = createContext(request, methods, options);
  const store = new CustodianSessionStore();
  store.connect(harness.context, variant);
  return { ...harness, store, request };
}
function healthFixture(healthRequest: Parameters<typeof createContext>[0], onboarding = false) {
  return setupStore(
    vi.fn().mockResolvedValue({ sessionId: "health-session", action: "none" }),
    ["openclaw.chat"],
    { healthRequest },
    onboarding ? "onboarding" : "caretaker",
  );
}
const idle = (store: CustodianSessionStore) => waitForFast(() => expect(store.sending).toBe(false));
const canSend = (store: CustodianSessionStore) =>
  waitForFast(() => expect(store.canSend).toBe(true));

beforeEach(() => {
  installSafeLocalStorageForTesting(window).clear();
});

afterEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

it.each(["cold", "startup", "metadata"] as const)(
  "retains setting drafts through %s initialization",
  async (phase) => {
    const startup = deferred<never>();
    const request = vi.fn().mockResolvedValue(chatReply("plugin-help-session"));
    if (phase !== "cold") {
      request.mockReturnValueOnce(startup.promise);
    }
    const { context, setPathname, setGatewaySnapshot } = createContext(request);
    setPathname("/settings/plugins/example");
    publishPluginHelpContext(context, {}, plugin, { overview: false, installed: true });
    const agentsList = context.agents.state.agentsList;
    if (phase === "metadata") {
      context.agents.state.agentsList = null;
    }
    const store = new CustodianSessionStore();
    if (phase !== "cold") {
      store.connect(context, "caretaker");
      store.setInput("Keep this draft.");
    }
    const selectedSetting =
      phase === "cold"
        ? setting(["plugins", "entries", "example", "config", "names.with.dots"], "Names", [
            "first",
          ])
        : setting(["limit"], "Limit", 5);
    await ask(context, selectedSetting);
    if (phase === "cold") {
      expect(request).not.toHaveBeenCalled();
      store.connect(context, "caretaker");
      await canSend(store);
      expect(store.input).toBe('Explain Names\n\nCurrent value: ["first"]');
    } else {
      expect(store.input).toBe("Keep this draft.\n\nExplain Limit\n\nCurrent value: 5");
      expect(store.canSend).toBe(false);
      if (phase === "metadata") {
        expect(request).not.toHaveBeenCalled();
        context.agents.state.agentsList = agentsList;
        setGatewaySnapshot({});
        expect(store.input).toBe("Keep this draft.\n\nExplain Limit\n\nCurrent value: 5");
      }
      startup.reject(new Error("Fixture inference unavailable"));
      await waitForFast(() => expect(store.error).toContain("Fixture inference unavailable"));
      store.setInput(`${store.input}\nUse a brief answer.`);
      const edited = store.input;
      await store.send();
      expect(request).toHaveBeenCalledOnce();
      store.retry();
      await canSend(store);
      expect(store.input).toBe(edited);
    }
    expect(request.mock.calls.every((call) => call[1].message === undefined)).toBe(true);
    const message = store.input;
    await store.send();
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionId: "plugin-help-session",
      message,
      context: {
        plugin: {
          ...plugin,
          setting: { path: selectedSetting.path, label: selectedSetting.label },
        },
      },
    });
  },
);

it("keeps setting drafts separate from hosted secret answers", async () => {
  const { request, context, store } = setupStore();
  await canSend(store);
  store.setInput("Keep this ordinary draft.");
  store.sensitive = true;
  store.wizardInputPending = true;
  store.setInput("synthetic-answer");
  await ask(
    context,
    setting(
      ["plugins", "entries", "example", "config", "apiKey"],
      "API key",
      "synthetic-secret",
      true,
    ),
  );
  expect(store.input).toBe("synthetic-answer");
  expect(request).toHaveBeenCalledOnce();
  store.sensitive = false;
  store.wizardInputPending = false;
  store.setInput(store.input);
  expect(store.input).toBe(
    "Keep this ordinary draft.\n\nExplain API key\n\nCurrent value: <redacted>",
  );
});

it("redacts nested secrets, references, sentinels and credential URLs", async () => {
  const { context, store } = setupStore();
  await canSend(store);
  const path = ["plugins", "entries", "example", "config", "accounts"];
  const hints = { "plugins.entries.example.config.accounts.*.opaque": { sensitive: true } };
  const values = [
    { work: { opaque: "nested-secret" } },
    { source: "env", provider: "default", id: "PRIVATE_KEY" },
    { value: "__OPENCLAW_REDACTED__" },
    "https://fixture-user:fixture-password@example.invalid/",
    "https://example.invalid/?access_token=fixture-token&safe=keep",
    { endpoints: ["https://example.invalid/#client_secret=fixture-secret"] },
    { "https://fixture-user:fixture-password@example.invalid/": "route" },
    "https://example.invalid/?next=https%3A%2F%2Fnested.invalid%2F%3Fapi_key%3Dfixture-key",
    "https%3A%2F%2Ffixture-user%3Afixture-password%40example.invalid%2F",
    `https://example.invalid/${"x".repeat(520)}?token=fixture-token`,
  ];
  for (const value of values) {
    const original = structuredClone(value);
    store.setInput("");
    await ask(
      context,
      setting(path, "Accounts", value, hasSensitiveConfigData(value, path, hints)),
    );
    expect(store.input).toBe("Explain Accounts\n\nCurrent value: <redacted>");
    expect(value).toEqual(original);
  }
  const value = { endpoints: ["https://example.invalid/?region=eu&discount=100%25"] };
  const original = structuredClone(value);
  store.setInput("");
  await ask(context, setting(path, "Accounts", value));
  expect(store.input).toContain(`Current value: ${JSON.stringify(original)}`);
  expect(value).toEqual(original);
});

it.each(["operator", "navigation"] as const)(
  "retires plugin context on %s change",
  async (change) => {
    const request = vi.fn().mockResolvedValue(chatReply("plugin-help-session"));
    const { context, setGatewayToken, setPathname } = createContext(request);
    setPathname("/settings/plugins/example");
    const owner = {};
    const releaseOld = publishPluginHelpContext(
      context,
      owner,
      { id: "first", name: "First" },
      { overview: true, installed: true },
    );
    const currentPlugin = { id: "second", name: "Second" };
    const releaseCurrent = publishPluginHelpContext(context, owner, currentPlugin, {
      overview: true,
      installed: true,
    });
    releaseOld();
    expect(currentPluginHelpReference(context)?.id).toBe("second");
    const pending = ask(context, setting(["limit"], "Limit", 5), currentPlugin);
    if (change === "operator") {
      await pending;
      setGatewayToken("replacement-operator");
    } else {
      setPathname("/agents");
      await pending;
    }
    expect(currentPluginHelpReference(context)).toBeUndefined();
    releaseCurrent();
    const store = connectStore(context);
    await canSend(store);
    expect(store.input).toBe("");
  },
);

it("shares one session across repeated surface connections", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(chatReply("shared-session"))
    .mockResolvedValueOnce(chatReply("shared-session", "Still here."));
  const { context } = createContext(request);
  const store = new CustodianSessionStore();
  const firstSurfaceUpdates = vi.fn();
  const panelSurfaceUpdates = vi.fn();
  store.subscribe(firstSurfaceUpdates);
  store.subscribe(panelSurfaceUpdates);

  store.connect(context, "caretaker");
  store.connect(context, "caretaker");
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());

  await store.send("Check this system");

  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[1]?.[1]).toMatchObject({
    sessionId: "shared-session",
    message: "Check this system",
  });
  expect(text(store)).toEqual(["Ready.", "Check this system", "Still here."]);
  expect(store.hasRealUserTurn()).toBe(true);
  expect(firstSurfaceUpdates).toHaveBeenCalled();
  expect(panelSurfaceUpdates).toHaveBeenCalled();
});

it("reuses the persisted session id across store instances", async () => {
  const request = vi.fn(echoReply);
  const { context } = createContext(request);

  new CustodianSessionStore().connect(context, "caretaker");
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());
  const firstSessionId = request.mock.calls[0]?.[1].sessionId;
  expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe(firstSessionId);

  new CustodianSessionStore().connect(context, "caretaker");
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

  expect(request.mock.calls[1]?.[1].sessionId).toBe(firstSessionId);
});

it.each([false, true])("remints an invalidated session (live=%s)", async (live) => {
  const error = new GatewayRequestError({
    code: live ? "UNAVAILABLE" : "INVALID_REQUEST",
    message: live ? "OpenClaw session expired." : "OpenClaw session belongs to another caller.",
    details: buildSystemAgentSessionInvalidatedErrorDetails(),
  });
  const request = live
    ? vi
        .fn()
        .mockImplementationOnce(echoReply)
        .mockRejectedValueOnce(error)
        .mockImplementationOnce(echoReply)
    : vi.fn().mockRejectedValue(error);
  const { store } = setupStore(request);
  await idle(store);
  const staleSessionId = request.mock.calls[0]?.[1].sessionId;
  if (live) {
    expect(store.messages.at(-1)?.text).toBe("Ready.");
    await store.send("Continue");
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    const replacementSessionId = request.mock.calls[2]?.[1].sessionId;
    expect(replacementSessionId).not.toBe(staleSessionId);
    expect(localStorage.getItem("openclaw.custodian.session.v1")).toBe(replacementSessionId);
  } else {
    expect(localStorage.getItem("openclaw.custodian.session.v1")).not.toBe(staleSessionId);
    expect(store.canRetry()).toBe(true);
  }
});

it("coalesces history reads and blocks them during interaction", async () => {
  const pending = deferred<SystemAgentChatHistoryResult>();
  let historyCall = 0;
  const request = historyRequest(() =>
    ++historyCall === 1 ? Promise.resolve({ turns: [] }) : pending.promise,
  );
  const { store } = setupStore(request, historyMethods);
  await idle(store);

  const firstRefresh = store.refreshTranscriptIfIdle();
  const secondRefresh = store.refreshTranscriptIfIdle();
  expect(historyCall).toBe(2);
  pending.resolve({
    turns: [
      { role: "user", text: "Durable question", at: 10 },
      { role: "assistant", text: "Durable answer", at: 11 },
    ],
  });
  await Promise.all([firstRefresh, secondRefresh]);
  expect(text(store)).toEqual(["Durable question", "Durable answer"]);
  const historyCallCount = request.mock.calls.filter(
    ([method]) => method === "openclaw.chat.history",
  ).length;

  store.sending = true;
  await store.refreshTranscriptIfIdle();
  store.sending = false;
  store.wizardInputPending = true;
  await store.refreshTranscriptIfIdle();
  store.wizardInputPending = false;
  store.messages = [
    {
      ...store.messages[1]!,
      question: {
        id: "repair",
        header: "Repair",
        question: "What should OpenClaw repair?",
        options: [{ label: "Gateway" }, { label: "Channel" }],
        isOther: false,
      },
    },
  ];
  await store.refreshTranscriptIfIdle();

  expect(request.mock.calls.filter(([method]) => method === "openclaw.chat.history")).toHaveLength(
    historyCallCount,
  );
  expect(store.messages[0]?.question?.id).toBe("repair");
});

it("keeps transcript errors when a turn invalidates retry", async () => {
  const retry = deferred<SystemAgentChatHistoryResult>();
  const reply = deferred<SystemAgentChatResult>();
  let historyCall = 0;
  const request = historyRequest(
    () => (++historyCall === 1 ? Promise.reject(new Error("history unavailable")) : retry.promise),
    (params) => (params.message ? reply.promise : Promise.resolve(chatReply(params.sessionId))),
  );
  const { store } = setupStore(request, historyMethods);
  await idle(store);
  expect(store.transcript.status.error).toContain("history unavailable");

  const refresh = store.refreshTranscriptIfIdle();
  const send = store.send("Continue");
  retry.resolve({ turns: [{ role: "assistant", text: "Stale history", at: 2 }] });
  await refresh;

  expect(store.transcript.status.error).toContain("history unavailable");
  expect(store.messages.some((message) => message.text === "Stale history")).toBe(false);
  reply.resolve(chatReply("session-after-send", "Continued."));
  await send;
});

it("rejoins abandoned turns with authoritative history and controls", async () => {
  const initialRequest = historyRequest(
    () => Promise.resolve({ turns: [] }),
    (params, options) =>
      params.message
        ? new Promise((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted")));
          })
        : Promise.resolve(chatReply(params.sessionId)),
  );
  const { store, setGatewaySnapshot } = setupStore(initialRequest, historyMethods);
  await idle(store);

  const interruptedSend = store.send("Finish the repair");
  await waitForFast(() => expect(store.sending).toBe(true));
  setGatewaySnapshot({ phase: "reconnecting", client: null });
  expect(store.abandonedTurnOutcomeUnknown).toBe(true);

  const liveStep = { id: "repair-step", type: "text", message: "Which channel?" };
  const reconnectRequest = vi.fn((method: string, params: { sessionId?: string }) => {
    if (method === "health") {
      return Promise.resolve({ channels: {} });
    }
    if (method === "openclaw.chat.history") {
      return Promise.resolve({
        turns: [
          { role: "user", text: "Finish the repair", at: 20 },
          { role: "assistant", text: "Repair complete", at: 21 },
        ],
      });
    }
    if (method === "openclaw.chat") {
      return Promise.resolve({
        sessionId: params.sessionId,
        reply: "Welcome back.",
        action: "none",
        wizardInputPending: true,
        step: liveStep,
      });
    }
    throw new Error(`Unexpected reconnect method: ${method}`);
  });
  setGatewaySnapshot({
    phase: "connected",
    client: { request: reconnectRequest } as unknown as GatewayBrowserClient,
  });
  await interruptedSend;
  await waitForFast(() => expect(store.messages.at(-1)?.step).toMatchObject({ id: "repair-step" }));
  expect(store).toMatchObject({ abandonedTurnOutcomeUnknown: false, wizardInputPending: true });
  expect(store.messages.some((message) => message.text === "Repair complete")).toBe(true);
  expect(reconnectRequest.mock.calls.some(([method]) => method === "openclaw.chat")).toBe(true);
});

it.each([
  [
    inferenceFailure("The configured runtime could not start. Repair the launcher and retry."),
    false,
  ],
  [new Error("The greeting could not start. Retry after repairing the runtime."), false],
  [new Error("OPENAI_API_KEY=sk-1234567890abcdef"), false],
  [inferenceFailure("Runtime verification failed."), true],
] as const)(
  "re-verifies inference without replaying user turns: %s (live=%s)",
  async (error, live) => {
    const displayed = error.message.startsWith("OPENAI_API_KEY=")
      ? "OPENAI_API_KEY=sk-123...cdef"
      : error.message;
    const request = vi.fn();
    if (live) {
      request.mockResolvedValueOnce(chatReply("shared-session"));
    }
    request
      .mockImplementationOnce((_method, _params, options?: { onSent?: () => void }) => {
        if (live) {
          options?.onSent?.();
        }
        return Promise.reject(error);
      })
      .mockResolvedValueOnce(chatReply("shared-session", live ? "Recovered." : "Ready."));
    const { store } = setupStore(request);
    if (live) {
      await idle(store);
      await store.send("Check this system");
      expect(text(store)).toContain("Check this system");
    } else {
      await waitForFast(() => expect(store.error).toBe(displayed));
    }
    expect(store).toMatchObject({ error: displayed, setupRequired: false });
    await expect(store.send("should not send")).resolves.toBe("rejected");
    expect(request).toHaveBeenCalledTimes(live ? 2 : 1);
    const draft = live ? "Next question" : "Keep my draft";
    store.setInput(draft);
    store.retry();
    await waitForFast(() =>
      expect(store.messages.at(-1)?.text).toBe(live ? "Recovered." : "Ready."),
    );
    expect(store).toMatchObject({ input: draft, error: null });
    expect(request).toHaveBeenCalledTimes(live ? 3 : 2);
    expect(request.mock.calls.at(-1)?.[1]).not.toHaveProperty("message");
    if (live) {
      expect(text(store)).toContain("Check this system");
    }
  },
);

it.each([
  { edits: [], expected: "Original question" },
  { edits: ["New question"], expected: "New question" },
  { edits: ["New question", ""], expected: "" },
])("retains the latest unsent draft: $edits", async ({ edits, expected }) => {
  const pending = deferred();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ sessionId: "draft-session", reply: "Ready." })
    .mockImplementationOnce(() =>
      pending.promise.then(() => {
        throw new Error("Request was not sent.");
      }),
    );
  const { store } = setupStore(request);
  await canSend(store);
  store.setInput("Original question");
  const sending = store.send();
  expect(store.input).toBe("");
  for (const edit of edits) {
    store.setInput(edit);
  }
  pending.resolve();
  await expect(sending).resolves.toBe("rejected");
  expect(store.input).toBe(expected);
  expect(store.hasRealUserTurn()).toBe(false);
  expect(store.error).toBe("Request was not sent.");
  expect(request).toHaveBeenCalledTimes(2);
});

it.each([false, true])("allows only configured models or setup utilities (%s)", async (utility) => {
  const request = vi.fn();
  if (utility) {
    request.mockResolvedValue(
      chatReply("utility-setup-session", "Choose a primary model for your agent."),
    );
  }
  const { context } = createContext(request, ["openclaw.chat"], {
    agentsList: {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", ...(utility ? { utilityModel: "local/setup" } : {}) }],
    },
  });
  const store = new CustodianSessionStore();
  store.connect(context, utility ? "onboarding" : "caretaker");
  if (!utility) {
    expect(store.setupRequired).toBe(true);
    expect(store.sending).toBe(false);
    expect(request).not.toHaveBeenCalled();
    await expect(store.send("should not send")).resolves.toBe("rejected");
    return;
  }
  await waitForFast(() => expect(store.messages.at(-1)?.text).toContain("Choose a primary"));
  expect(store).toMatchObject({ setupRequired: false, canSend: true });
  expect(request.mock.calls[0]?.[1]).toMatchObject({ welcomeVariant: "onboarding" });
  expect(context.agents.state.agentsList?.agents[0]?.model?.primary).toBeUndefined();
  store.exitSetup();
  expect(context.navigate).toHaveBeenCalledWith("model-setup", { search: "?firstRun=1" });
});

it.each(["chat", "channels", "model-setup"] as const)(
  "prevents late replies from navigating away from %s",
  async (destination) => {
    const reply = deferred<unknown>();
    const request = vi.fn((..._args: RequestArgs) => reply.promise);
    if (destination === "chat") {
      request.mockReturnValueOnce(reply.promise).mockReturnValue(new Promise(() => {}));
    }
    const { context, store } = setupStore(
      request,
      undefined,
      undefined,
      destination === "model-setup" ? "caretaker" : "onboarding",
    );
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    if (destination === "channels") {
      store.openChannelsFromOnboarding();
    } else {
      store.exitSetup(destination);
    }
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(store.sending).toBe(false);
    if (destination === "chat") {
      store.connect(context, "caretaker");
      await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    }
    reply.resolve({
      sessionId: "late-session",
      reply: "Your agent is ready.",
      action: "open-agent",
      agentId: "main",
      agentDraft: "hatch",
    });
    await Promise.resolve();
    expect(context.navigate).toHaveBeenCalledTimes(1);
    expect(context.navigate).toHaveBeenCalledWith(destination);
    expect(context.agents.refreshList).not.toHaveBeenCalled();
    if (destination === "chat") {
      expect(store.messages).toEqual([]);
    }
    if (destination === "channels") {
      expect(store.canRetry()).toBe(false);
    }
  },
);

it("loads health on caretaker activation and reconnect", async () => {
  const healthRequest = vi.fn().mockResolvedValue(reloadFailure);
  const { context, store, setGatewaySnapshot } = healthFixture(healthRequest, true);
  const client = context.gateway.snapshot.client;
  expect(healthRequest).not.toHaveBeenCalled();
  store.connect(context, "caretaker");
  await waitForFast(() => expect(store.eventNudge?.kind).toBe("config-reload"));

  store.connect(context, "caretaker");
  setGatewaySnapshot({});
  expect(healthRequest).toHaveBeenCalledOnce();
  healthRequest.mockResolvedValue({ channels: {} });
  setGatewaySnapshot({ phase: "reconnecting", client: null });
  setGatewaySnapshot({ phase: "connected", client });
  await waitForFast(() => expect(store.eventNudge).toBeNull());
  expect(healthRequest).toHaveBeenCalledTimes(2);
});

it("retries failed health on tick, then stops polling", async () => {
  const initialHealth = deferred<unknown>();
  const healthRequest = vi
    .fn()
    .mockReturnValueOnce(initialHealth.promise)
    .mockResolvedValue(reloadFailure);
  const { store, emitGatewayEvent } = healthFixture(healthRequest);
  emitGatewayEvent({ event: "tick", payload: {} });
  expect(healthRequest).toHaveBeenCalledOnce();

  initialHealth.reject(new Error("Temporary health failure"));
  await initialHealth.promise.catch(() => undefined);
  await Promise.resolve();
  expect(healthRequest).toHaveBeenCalledOnce();
  emitGatewayEvent({ event: "tick", payload: {} });
  await waitForFast(() => expect(store.eventNudge?.kind).toBe("config-reload"));
  emitGatewayEvent({ event: "tick", payload: {} });
  expect(healthRequest).toHaveBeenCalledTimes(2);
});

it.each(["event", "reconnect", "variant", "operator"] as const)(
  "rejects stale health after %s changes",
  async (change) => {
    const pending = deferred<unknown>();
    const healthRequest = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ channels: {} });
    const { context, store, emitGatewayEvent, setGatewaySnapshot, setGatewayToken } =
      healthFixture(healthRequest);
    await waitForFast(() => expect(healthRequest).toHaveBeenCalledOnce());
    if (change === "event") {
      emitGatewayEvent({ event: "health", payload: { channels: {} } });
    } else if (change === "reconnect") {
      const client = context.gateway.snapshot.client;
      setGatewaySnapshot({ phase: "reconnecting", client: null });
      setGatewaySnapshot({ phase: "connected", client });
    } else if (change === "variant") {
      store.connect(context, "onboarding");
    } else {
      setGatewayToken("replacement-operator");
      setGatewaySnapshot({});
    }
    pending.resolve(reloadFailure);
    await pending.promise;
    expect(store.eventNudge).toBeNull();
  },
);

it("accepts new event nudges after a conversation variant rotates", async () => {
  const request = vi.fn().mockResolvedValue(chatReply("shared-session"));
  const { context, store, emitGatewayEvent } = setupStore(request);
  await waitForFast(() => expect(request).toHaveBeenCalledOnce());

  emitGatewayEvent({
    event: "health",
    payload: reloadFailure,
  });
  expect(store.eventNudge).not.toBeNull();
  store.dismissEventNudge();
  expect(store.eventNudge).toBeNull();

  store.connect(context, "onboarding");
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
  store.connect(context, "caretaker");
  await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
  emitGatewayEvent({
    event: "health",
    payload: reloadFailure,
  });

  expect(store.eventNudge).not.toBeNull();
});
