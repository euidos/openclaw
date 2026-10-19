/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createNativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { createNativeDeviceSettingsSnapshot } from "../../test-helpers/native-device-settings.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { SetupAutoResult } from "./custodian-auto-setup.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import { CustodianSessionStore } from "./custodian-session-store.ts";

const selected = {
  kind: "codex",
  label: "ChatGPT",
  detail: "Saved sign-in",
  modelRef: "openai/gpt-5.5",
};
const alternative = {
  kind: "ollama",
  label: "Local model",
  detail: "Running locally",
  modelRef: "ollama/qwen3",
};
function result(status: SetupAutoResult["status"] = "activated"): SetupAutoResult {
  return { status, selected, alternatives: [alternative], attempts: [], installedPlugins: [] };
}
const methods = [
  "openclaw.chat",
  "openclaw.setup.auto",
  "openclaw.setup.activate",
  "openclaw.setup.auth.start",
];
const agentsList: AgentsListResult = {
  defaultId: "main",
  mainKey: "main",
  scope: "global",
  agents: [{ id: "main" }],
};
const reply = {
  sessionId: "setup-session",
  reply: "Welcome. What would you like to set up?",
  action: "none",
};
type Page = Awaited<ReturnType<typeof mountPage>>["page"];
function setupRequest(
  auto: () => unknown = () => result(),
  handlers: Record<string, (params?: { answer?: unknown }) => unknown> = {},
) {
  return vi.fn(async (method: string, params?: { answer?: unknown }) =>
    method === "openclaw.setup.auto" ? auto() : (handlers[method]?.(params) ?? reply),
  );
}
function unavailable(attempts: SetupAutoResult["attempts"] = []): SetupAutoResult {
  return { status: "unavailable", alternatives: [], attempts, installedPlugins: [] };
}
const setupContext = (request: Parameters<typeof createContext>[0]) =>
  createContext(request, methods, { agentsList });
async function mountSetup(request: Parameters<typeof createContext>[0]) {
  const harness = setupContext(request);
  const mounted = await mountPage(harness.context);
  await settled(mounted.page);
  return { ...harness, ...mounted };
}
async function settled(page: Page, expected = () => true) {
  await new Promise<void>((resolve) => {
    const ready = () => {
      const setup = page.store.autoSetup;
      if (
        !expected() ||
        setup.pending ||
        page.store.sending ||
        setup.wizard.state.phase === "starting" ||
        (setup.wizard.state.phase === "step" && setup.wizard.state.busy)
      ) {
        return;
      }
      unsubscribe();
      resolve();
    };
    const unsubscribe = page.store.subscribe(ready);
    ready();
  });
  flush();
  await page.updateComplete;
}
function click(page: Page, text: string) {
  const button = [...page.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === text,
  );
  expect(button).toBeDefined();
  button!.click();
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  delete window["__OPENCLAW_NATIVE_SETUP__"];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])(
  "selects an alternative only after successful activation (%s)",
  async (ok) => {
    const setup = createDeferred<SetupAutoResult>();
    const request = setupRequest(() => setup.promise, {
      "openclaw.setup.activate": () =>
        ok ? { ok, modelRef: alternative.modelRef } : { ok, error: "Local model is offline" },
    });
    const { context } = setupContext(request);
    const { page } = await mountPage(context);
    expect(page.textContent).toContain("Connecting your AI");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.setup.auto"]);
    expect(request).toHaveBeenCalledWith("openclaw.setup.auto", {}, { timeoutMs: null });
    setup.resolve(result(ok ? "configured" : "activated"));
    await setup.promise;
    await settled(page);
    expect(page.textContent).toContain("Using ChatGPT (openai/gpt-5.5) on gateway.test");
    expect(page.textContent).toContain(reply.reply);
    click(page, "Local model");
    await settled(page);
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.activate",
      { kind: "ollama" },
      { timeoutMs: null },
    );
    expect(page.textContent).toContain(
      ok ? "Using Local model (ollama/qwen3) on gateway.test" : "Using ChatGPT",
    );
    if (!ok) {
      expect(page.querySelector('[role="alert"]')?.textContent).toContain("Local model is offline");
    }
    expect(request.mock.calls.filter(([method]) => method === "openclaw.setup.auto")).toHaveLength(
      1,
    );
  },
);

it("follows a replacement store without accepting the old store's dismissal", async () => {
  let autoCalls = 0;
  const request = setupRequest(() => ({
    ...result(),
    selected: autoCalls++ === 0 ? selected : alternative,
  }));
  const { page } = await mountSetup(request);
  const previous = page.store;
  page.store = new CustodianSessionStore();
  await settled(page, () => page.store.autoSetup.ready);
  expect(page.textContent).toContain("Using Local model (ollama/qwen3)");
  previous.autoSetup.dismiss();
  flush();
  await page.updateComplete;
  expect(page.querySelector(".custodian-setup")).not.toBeNull();
  expect(page.textContent).toContain("Using Local model (ollama/qwen3)");
  expect(page.textContent).not.toContain("Using ChatGPT");
});

it.each(["needs-sign-in", "configured"] as const)(
  "uses the existing sign-in wizard from %s and refreshes the card after success",
  async (status) => {
    let autoCalls = 0;
    const request = setupRequest(
      () => {
        if (autoCalls++) {
          return result();
        }
        return status === "needs-sign-in"
          ? {
              ...unavailable(),
              status,
              installedPlugins: ["codex"],
              signIn: { authOptionId: "codex-sign-in", label: "ChatGPT" },
            }
          : {
              ...result(status),
              selected: { ...selected, shared: true },
              separateSignIn: { authOptionId: "codex-separate-sign-in", label: "ChatGPT" },
            };
      },
      {
        "openclaw.setup.auth.start": () => ({ sessionId: "auth-session", done: false }),
        "wizard.next": (params) =>
          params?.answer
            ? { done: true, status: "done" }
            : {
                done: false,
                step: { id: "confirm", type: "confirm", message: "Finish signing in?" },
              },
      },
    );
    const { page } = await mountSetup(request);
    if (status === "needs-sign-in") {
      expect(request.mock.calls.filter(([method]) => method === "openclaw.chat")).toHaveLength(0);
    } else {
      expect(page.textContent).toContain(
        "Using your existing Codex login · sessions shared with Codex",
      );
    }
    click(page, status === "needs-sign-in" ? "Sign in with ChatGPT" : "Use a separate login");
    await settled(page);
    expect(request).toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      expect.objectContaining({
        authChoice: status === "needs-sign-in" ? "codex-sign-in" : "codex-separate-sign-in",
      }),
      { timeoutMs: null },
    );
    expect(page.textContent).toContain("Finish signing in?");
    click(page, "Yes");
    await settled(
      page,
      () =>
        autoCalls === 2 &&
        page.store.autoSetup.ready &&
        !page.store.autoSetup.result?.selected?.shared,
    );
    expect(autoCalls).toBe(2);
    expect(page.textContent).toContain("Using ChatGPT");
    expect(page.textContent).toContain(reply.reply);
    expect(page.textContent).not.toContain("sessions shared with Codex");
    expect(page.textContent).not.toContain("Use a separate login");
  },
);

it("shows unavailable attempts and the terminal fallback", async () => {
  const request = vi.fn(async () =>
    unavailable([{ kind: "codex", label: "ChatGPT", error: "Could not prepare the plugin" }]),
  );
  const { page } = await mountSetup(request);
  expect(page.textContent).toContain("Could not prepare the plugin");
  expect(page.textContent).toContain("openclaw onboard");
  expect(page.textContent).toContain("only connect tools you trust");
  expect(request).toHaveBeenCalledTimes(1);
});

it("uses shell-neutral native capabilities for fallback, Gateway selection, and permissions", async () => {
  const openAiSetup = vi.fn();
  const openGateways = vi.fn();
  const reviewPermissions = vi.fn();
  window["__OPENCLAW_NATIVE_SETUP__"] = { openAiSetup, openGateways, reviewPermissions };
  const request = vi.fn(async () => unavailable());
  const { page } = await mountSetup(request);
  click(page, "Open AI setup");
  click(page, "Use a different Gateway");
  click(page, "Review permissions");
  expect(openAiSetup).toHaveBeenCalledOnce();
  expect(openGateways).toHaveBeenCalledOnce();
  expect(reviewPermissions).toHaveBeenCalledOnce();
  expect(page.textContent).not.toContain("openclaw onboard");
});

it("updates native recovery when its capability snapshot arrives", async () => {
  const snapshot = createNativeDeviceSettingsSnapshot();
  const post = vi.fn().mockResolvedValue(snapshot);
  vi.stubGlobal("webkit", { messageHandlers: { openclawDeviceSettings: { postMessage: post } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_DEVICE_SETTINGS__", snapshot);
  const nativeDeviceSettings = createNativeDeviceSettingsCapability()!;
  const request = vi.fn(async () => unavailable());
  const { context } = setupContext(request);
  try {
    const { page } = await mountPage({ ...context, nativeDeviceSettings });
    await settled(page);
    expect(page.textContent).toContain("openclaw onboard");
    window.dispatchEvent(
      new CustomEvent("openclaw:native-device-settings-changed", {
        detail: {
          ...snapshot,
          capabilities: { ...snapshot.capabilities, aiSetupAvailable: true },
        },
      }),
    );
    await settled(page);
    click(page, "Open AI setup");
    expect(post).toHaveBeenCalledWith({ type: "open", panel: "ai-setup" });
    expect(page.textContent).not.toContain("openclaw onboard");
  } finally {
    nativeDeviceSettings.dispose();
  }
});

it("shows RPC failures and retries without a premature greeting", async () => {
  const request = setupRequest(() => {
    throw new Error("Gateway lost its connection");
  });
  const { page } = await mountSetup(request);
  expect(page.querySelector('[role="alert"]')?.textContent).toContain(
    "Gateway lost its connection",
  );
  expect(request).toHaveBeenCalledTimes(1);
  click(page, "Retry");
  await settled(page);
  expect(request).toHaveBeenCalledTimes(2);
});

it("persists dismissal across a new custodian store", async () => {
  const request = setupRequest();
  const { context } = setupContext(request);
  const first = await mountPage(context);
  await settled(first.page);
  first.page.querySelector<HTMLButtonElement>('[aria-label="Dismiss"]')!.click();
  await settled(first.page);
  expect(first.page.querySelector(".custodian-setup")).toBeNull();
  first.provider.remove();
  const second = await mountPage(context);
  await settled(second.page);
  expect(second.page.querySelector(".custodian-setup")).toBeNull();
  expect(second.page.textContent).toContain(reply.reply);
});

it("ignores an old Gateway result after connection ownership changes", async () => {
  const pending = createDeferred<SetupAutoResult>();
  const request = vi.fn(async () => pending.promise);
  const { context, setGatewaySnapshot } = setupContext(request);
  const { page } = await mountPage(context);
  const replacement = setupRequest(() => ({ ...result(), selected: alternative }));
  setGatewaySnapshot({
    client: { request: replacement } as unknown as GatewayBrowserClient,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.admin"], deviceToken: "synthetic-new-owner" },
      features: { methods },
    },
  });
  await settled(page);
  pending.resolve(result());
  await pending.promise;
  await settled(page);
  expect(page.textContent).toContain("Using Local model");
  expect(page.textContent).not.toContain("Using ChatGPT");
});

it("preserves the existing caretaker flow without the advertised method", async () => {
  const request = vi.fn(async () => reply);
  const { context } = createContext(request, ["openclaw.chat"], { agentsList });
  const { page } = await mountPage(context, { onboarding: false });
  await settled(page);
  expect(page.querySelector(".custodian-setup")).toBeNull();
  expect(request).not.toHaveBeenCalled();
  expect(page.querySelector(".custodian__setup-state")).not.toBeNull();
});
