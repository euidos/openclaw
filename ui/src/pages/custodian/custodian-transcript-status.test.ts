/* @vitest-environment jsdom */

import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import * as uuid from "../../lib/uuid.ts";
import { QUICK_ACTIONS_QUESTION } from "../../test-helpers/custodian-quick-actions.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type Page = Awaited<ReturnType<typeof mountPage>>["page"];
function unavailable(message = "Gateway is suspending") {
  return new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    details: { reason: "gateway-suspending", phase: "draining" },
  });
}
const history = (text: string) => ({ turns: [{ role: "assistant", text, at: 1 }] });
function reopen(set: ReturnType<typeof createContext>["setGatewaySnapshot"]) {
  set({ suspensionPhase: "draining" });
  set({ suspensionPhase: "accepting" });
}
async function mountTranscript(request: Parameters<typeof createContext>[0]) {
  const harness = createContext(request, ["openclaw.chat", "openclaw.chat.history"]);
  return { ...harness, ...(await mountPage(harness.context)) };
}
function expectNoStatus(page: Page) {
  expect(page.querySelector(".custodian__transcript-status")).toBeNull();
  expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
}

describe("custodian transcript status", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(uuid, "generateUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "continues to the welcome and automatically recovers history (lifecycle failure: %s)",
    async (lifecycleFailure) => {
      let historyCalls = 0;
      const request = vi.fn(
        async (method: string, _params?: unknown, options?: { timeoutMs?: number }) => {
          if (method === "openclaw.chat.history") {
            expect(options).toEqual({ timeoutMs: 15_000 });
            historyCalls += 1;
            if (historyCalls === 1) {
              throw lifecycleFailure ? unavailable() : new Error("history request timed out");
            }
            return history("Recovered history.");
          }
          return {
            sessionId: "engine-session-after-history-timeout",
            reply: "Welcome without history.",
            action: "none",
            question: QUICK_ACTIONS_QUESTION,
          };
        },
      );
      const { page, setGatewaySnapshot } = await mountTranscript(request);

      await waitForFast(() => expect(page.textContent).toContain("Welcome without history."));
      const historyAlert = Array.from(page.querySelectorAll<HTMLElement>('[role="alert"]')).find(
        (alert) => alert.textContent?.includes("history request timed out"),
      );
      if (lifecycleFailure) {
        expect(page.querySelector(".custodian__transcript-status")).toBeNull();
      } else {
        expect(historyAlert).toBeDefined();
        expect(historyAlert?.querySelector("button")).toBeNull();
      }
      reopen(setGatewaySnapshot);
      setGatewaySnapshot({ suspensionPhase: "accepting" });
      await waitForFast(() => expect(page.textContent).toContain("Recovered history."));
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.chat.history",
        "openclaw.chat",
        "openclaw.chat.history",
      ]);
    },
  );

  it("waits for a pending history failure before recovering after admission reopens", async () => {
    const pending = deferred<never>();
    let historyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        return historyCalls === 2
          ? pending.promise
          : history(historyCalls === 1 ? "Earlier history" : "Recovered history");
      }
      return { sessionId: "custodian-session", reply: "Ready", action: "none" };
    });
    const { page, setGatewaySnapshot } = await mountTranscript(request);
    await waitForFast(() => expect(page.textContent).toContain("Ready"));
    const refresh = page.store.refreshTranscriptIfIdle();
    reopen(setGatewaySnapshot);
    reopen(setGatewaySnapshot);
    expect(historyCalls).toBe(2);
    pending.reject(unavailable("Gateway was suspending"));
    await refresh;
    await waitForFast(() => expect(page.textContent).toContain("Recovered history"));
    expect(page.querySelector(".custodian__transcript-status")).toBeNull();
    expect(historyCalls).toBe(3);
  });

  it("does not retry failed reconnect hydration again on the same availability edge", async () => {
    let historyCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        if (historyCalls === 2) {
          throw unavailable();
        }
        return history("Recovered reconnect history");
      }
      return { sessionId: "custodian-session", reply: "Ready", action: "none" };
    });
    const { page, setGatewaySnapshot } = await mountTranscript(request);
    await waitForFast(() => expect(page.textContent).toContain("Ready"));
    setGatewaySnapshot({ phase: "stopped" });
    setGatewaySnapshot({ phase: "connected" });
    await waitForFast(() => {
      expect(page.store.transcript.refreshing).toBe(false);
      expect(page.store.transcript.status.awaitingGateway).toBe(true);
    });
    expect(historyCalls).toBe(2);
    reopen(setGatewaySnapshot);
    await waitForFast(() => expect(page.store.transcript.status.awaitingGateway).toBe(false));
    expect(historyCalls).toBe(3);
    expect(page.textContent).toContain("Recovered reconnect history");
  });

  it("recovers parked history once after an in-flight send settles", async () => {
    const reply = deferred<SystemAgentChatResult>();
    let historyCalls = 0;
    const request = vi.fn(async (method: string, params?: { message?: string }) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        if (historyCalls === 1) {
          throw unavailable();
        }
        return history("Recovered after send");
      }
      return params?.message
        ? reply.promise
        : { sessionId: "custodian-session", reply: "Ready", action: "none" };
    });
    const { page, setGatewaySnapshot } = await mountTranscript(request);
    await waitForFast(() => expect(page.store.canSend).toBe(true));
    expect(page.store.transcript.status.awaitingGateway).toBe(true);

    const send = page.store.send("Continue");
    reopen(setGatewaySnapshot);
    reopen(setGatewaySnapshot);
    await page.updateComplete;
    expect(page.store.sending).toBe(true);
    expect(historyCalls).toBe(1);
    expectNoStatus(page);

    reply.resolve({ sessionId: "custodian-session", reply: "Done", action: "none" });
    await send;
    await waitForFast(() => expect(page.textContent).toContain("Recovered after send"));
    setGatewaySnapshot({ suspensionPhase: "accepting" });
    await page.updateComplete;
    expect(historyCalls).toBe(2);
    expectNoStatus(page);
  });

  it("does not automatically refresh history while the welcome or wizard is active", async () => {
    const welcome = deferred<{
      sessionId: string;
      reply: string;
      action: "none";
      wizardInputPending: true;
      step: { id: string; type: "text"; message: string };
    }>();
    const answer = deferred<SystemAgentChatResult>();
    let historyCalls = 0;
    let chatCalls = 0;
    const request = vi.fn((method: string) => {
      if (method === "openclaw.chat.history") {
        historyCalls += 1;
        return historyCalls === 1
          ? Promise.reject(new Error("history unavailable"))
          : Promise.resolve(history("Recovered after wizard"));
      }
      chatCalls += 1;
      return chatCalls === 1 ? welcome.promise : answer.promise;
    });
    const { page, setGatewaySnapshot } = await mountTranscript(request);

    await waitForFast(() =>
      expect(page.querySelector(".custodian__transcript-status")?.textContent).toContain(
        "history unavailable",
      ),
    );
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
    reopen(setGatewaySnapshot);
    await page.updateComplete;
    await waitForFast(() =>
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "openclaw.chat.history",
        "openclaw.chat",
      ]),
    );

    welcome.resolve({
      sessionId: "wizard-session",
      reply: "Choose one.",
      action: "none",
      wizardInputPending: true,
      step: { id: "choice", type: "text", message: "Continue?" },
    });
    await waitForFast(() => expect(page.querySelector(".custodian__wizard-step")).not.toBeNull());

    reopen(setGatewaySnapshot);
    await page.updateComplete;
    expect(page.querySelector(".custodian__transcript-status button")).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);

    const wizardMessage = page.store.messages.find((message) => message.step);
    expect(wizardMessage).toBeDefined();
    page.store.answerWizardStep(wizardMessage!, "Continue");
    await page.updateComplete;
    expect(page.store.sending).toBe(true);
    expect(historyCalls).toBe(1);

    answer.resolve({
      sessionId: "wizard-session",
      reply: "Wizard complete",
      action: "none",
      wizardInputPending: false,
    });
    await waitForFast(() => expect(page.textContent).toContain("Recovered after wizard"));
    expect(historyCalls).toBe(2);
    expectNoStatus(page);
  });
});
