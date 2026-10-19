import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import type { WizardStartResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import * as embeddedAgent from "../../agents/embedded-agent.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runSetupInferenceTurn } from "../../system-agent/setup-inference-turn.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { WizardSession } from "../../wizard/session.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import {
  createAdmittedWizardSession,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { publishWizardLoginSession, startWizardLogin } from "./wizard-login.js";
import { wizardHandlers } from "./wizard.js";

// mock-isolation: Authority probes exercise the live request scope, not a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

afterEach(() => vi.restoreAllMocks());
const device = { deviceId: "wizard-device", role: "operator" };

it.each([
  { revoked: false, progress: false },
  { revoked: false, progress: true },
  { revoked: true, progress: true },
])(
  "wizard.next probe authority (revoked=$revoked, progress=$progress)",
  async ({ revoked, progress }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const client = createOperatorClient({
        profileName: "wizard-authority",
        scopes: ["operator.admin"],
      });
      const context = Object.assign(createContext(), createWizardSessionTracker());
      const connection = new AbortController();
      const continueProbe = createDeferredCore();
      let probe: Awaited<ReturnType<typeof runSetupInferenceTurn>> | undefined;
      const run = vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async () => {
        if (revoked) {
          invalidateGatewayDeviceRevocation(context, device.deviceId, device.role);
        }
        const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "probe scope");
        const captured = expectDefined(
          await captureGatewayOperatorRunAuthority({
            ...scope,
            context,
            client: scope.client ?? null,
          }),
          "probe operator authority",
        );
        try {
          captured.authority.assertCurrent();
        } finally {
          captured.release();
        }
        return {
          payloads: [{ text: "OK" }],
          meta: {
            durationMs: 1,
            executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.6-sol" },
          },
        };
      });
      context.wizardRunner = async (_opts, _runtime, prompter) => {
        await prompter.confirm({ message: "Verify saved sign-in?" });
        if (progress) {
          prompter.progress("Checking saved sign-in");
          await continueProbe.promise;
        }
        const config = { agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
        probe = await runSetupInferenceTurn({
          requireExecutionOwner: false,
          route: {
            runner: "embedded",
            provider: "openai",
            model: "gpt-5.6-sol",
            modelLabel: "openai/gpt-5.6-sol",
            agentId: "main",
            agentDir: state.agentDir(),
            sourceConfig: config,
            runConfig: config,
          },
        });
        if (!probe.ok) {
          throw new Error(probe.error);
        }
      };

      async function request(
        method: "wizard.start" | "wizard.next",
        params: Record<string, unknown>,
      ) {
        const authority = captureGatewayDeviceRevocation(
          context,
          device,
          () => true,
          connection.signal,
        );
        const respond = vi.fn();
        const scope = {
          client,
          context,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: authority.isCurrent,
        };
        const options: GatewayRequestHandlerOptions = {
          req: { type: "req", id: method, method, params },
          params,
          respond,
          ...scope,
        };
        try {
          await withPluginRuntimeGatewayRequestScope(scope, () =>
            expectDefined(wizardHandlers[method], method)(options),
          );
          expect(respond).toHaveBeenCalledOnce();
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return respond.mock.calls[0]?.[1] as WizardStartResult;
        } finally {
          authority.release();
        }
      }

      const start = await request("wizard.start", { mode: "local" });
      expect(start.status).toBe("running");
      const session = expectDefined(context.wizardSessions.get(start.sessionId), "wizard session");
      try {
        let result = await request("wizard.next", {
          sessionId: start.sessionId,
          answer: { stepId: expectDefined(start.step, "initial step").id, value: true },
        });
        if (progress) {
          expect(result).toMatchObject({ status: "running", step: { type: "progress" } });
          continueProbe.resolve();
          result = await request("wizard.next", { sessionId: start.sessionId });
        }
        if (revoked) {
          expect(result.status).toBe("error");
          await expect(run.mock.results[0]?.value).rejects.toMatchObject({
            message: "Gateway caller authority is no longer active.",
          });
          expect(probe).toMatchObject({ ok: false });
        } else {
          expect([result.status, result.error]).toEqual(["done", undefined]);
          expect(probe).toMatchObject({ ok: true, text: "OK" });
        }
      } finally {
        continueProbe.resolve();
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    });
  },
);

it.each(["admission", "publication"])(
  "releases login setup when its connection closes before %s",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const connection = new AbortController();
      const client = Object.assign(
        createOperatorClient({ profileId: "login-owner", scopes: ["operator.admin"] }),
        { connectionSignal: connection.signal },
      );
      const context = Object.assign(createContext(), createWizardSessionTracker());
      const respond = vi.fn();
      const createSession = vi.fn(
        () =>
          new WizardSession(async (prompter) => {
            await prompter.confirm({ message: "Continue setup?" });
          }),
      );
      const params = {
        client,
        context,
        sessionId: "disconnected-login",
        respond,
        assertCurrent: vi.fn(),
        createSession,
      };
      const closed = new Error(`Connection closed before ${phase}`);
      const session =
        phase === "publication"
          ? expectDefined(
              await createAdmittedWizardSession(createSession),
              "admitted login session",
            )
          : undefined;
      connection.abort(closed);
      try {
        if (session) {
          await publishWizardLoginSession({ ...params, session });
          expect(session.signal.aborted).toBe(true);
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: "Login is no longer available on this connection.",
            }),
          );
        } else {
          await expect(startWizardLogin(params)).rejects.toThrow(closed.message);
          expect(createSession).not.toHaveBeenCalled();
        }
      } finally {
        for (const active of session ? [session] : context.wizardSessions.values()) {
          active.cancel();
          await whenAdmittedWizardSessionSettled(active);
        }
      }
      expect(context.wizardSessions.size).toBe(0);
      const replacement = expectDefined(
        await createAdmittedWizardSession(() => new WizardSession(async () => {})),
        "replacement setup admission",
      );
      await whenAdmittedWizardSessionSettled(replacement);
    });
  },
);
