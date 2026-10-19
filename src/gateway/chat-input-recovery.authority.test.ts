// Load the real Gateway/model runtime during collection, outside the proof deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import {
  createChatInputRecovery,
  normalizeChatSendRequest,
} from "./server-methods/chat-send-request.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "rechecks captured chat operators before startup replay reaches a model or tool",
  { timeout: 90_000 },
  async () => {
    const state = await createOpenClawTestState({
      label: "chat-replay-authority",
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const effectsPath = path.join(state.workspaceDir, "replayed.txt");
    const requests: string[] = [];
    const providerErrors: unknown[] = [];
    const providerServer = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(200).end('{"data":[]}');
          return;
        }
        const body = await readProviderBody(request);
        requests.push(body);
        const payload = JSON.parse(body) as { input: Array<{ type?: string }> };
        if (payload.input.some((item) => item.type === "function_call_output")) {
          writeOpenAiResponsesText(response, {
            text: "Replay completed.",
            messageId: randomUUID(),
            responseId: randomUUID(),
          });
        } else {
          writeToolCall(response, "write", { path: effectsPath, content: "UNCHANGED_OPERATOR" });
        }
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end();
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
        "chat-replay-authority",
      );
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { allow: ["write"] },
        gateway: {
          auth: { mode: "token", token: "synthetic-replay-token" },
          roles: {
            default: "writer",
            definitions: {
              writer: {
                agents: "*",
                sessions: { others: "none" },
                scopes: ["operator.read", "operator.write"],
              },
              revoked: { agents: [], sessions: { others: "none" }, scopes: ["operator.read"] },
            },
          },
        },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await loadOrCreateDeviceIdentityAsync();
      const cases = [];
      const owner = ensureProfileForEmail("owner@example.test");
      for (const change of ["unchanged", "role", "device", "membership"] as const) {
        const profile = ensureProfileForEmail(`${change}@example.test`);
        const sessionKey = `agent:main:replay-${change}`;
        const sessionId = `replay-${change}`;
        if (change === "membership") {
          // Creator attribution is immutable; seed the other owner before capture.
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            {
              sessionId,
              updatedAt: Date.now(),
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
        }
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          config,
          profileId: profile.id,
          scopes: ["operator.read", "operator.write"],
          sourceIngress: "internal",
          sessionKey,
          sessionId,
          sourceRunId: `replay-${change}`,
          ...(change === "device"
            ? {
                device: {
                  deviceId: "revoked-replay-device",
                  publicKey: "synthetic-public-key",
                  roles: ["operator"],
                  approvedScopes: ["operator.read", "operator.write"],
                  tokens: {
                    operator: {
                      token: "synthetic-device-token",
                      role: "operator",
                      scopes: ["operator.read", "operator.write"],
                      createdAtMs: 1,
                    },
                  },
                  createdAtMs: 1,
                  approvedAtMs: 1,
                },
              }
            : {}),
        });
        const normalized = await normalizeChatSendRequest({
          client: fixture.client,
          params: {
            sessionKey: fixture.target.sessionKey,
            idempotencyKey: fixture.target.sourceRunId,
            message: `REPLAY_${change.toUpperCase()}`,
            deliver: false,
          },
        });
        if (!normalized.ok) {
          throw new Error(normalized.error);
        }
        const recovery = expectDefined(
          createChatInputRecovery({
            request: normalized.value,
            source: fixture.entry.restartRecoveryOperatorSource,
          }),
          "captured chat authority",
        );
        // This proof resumes pending input, not the helper's separate main-turn claim.
        await replaceSessionEntry(fixture.target, {
          sessionId: fixture.entry.sessionId,
          updatedAt: fixture.entry.updatedAt,
          lifecycleRevision: fixture.entry.lifecycleRevision,
          createdActor: fixture.entry.createdActor,
          ...(change === "membership" ? { visibility: "read-only" } : {}),
        });
        if (change === "membership") {
          await addSessionMember(fixture.target, {
            identityId: profile.id,
            addedBy: owner.id,
          });
        }
        const receipt = expectDefined(
          await stageSessionPendingInput(fixture.target, {
            runId: fixture.target.sourceRunId,
            requestFingerprint: normalized.value.requestIdentity,
            message: {
              role: "user",
              content: `REPLAY_${change.toUpperCase()}`,
              timestamp: Date.now(),
              idempotencyKey: `${fixture.target.sourceRunId}:user`,
              __openclaw: {
                chatInputRecovery: recovery,
                chatRequestIdentity: normalized.value.requestIdentity,
              },
            },
            assertCurrent() {},
          }),
          "accepted pending input",
        );
        receipt.finish("interrupted");
        await receipt.settled?.();
        cases.push({ change, fixture });
        if (change === "role") {
          setUserProfileRole(profile.id, "revoked");
        }
        if (change === "device") {
          persistDevicePairingStoreState(
            { pendingById: {}, pairedByDeviceId: {} },
            state.stateDir,
            "both",
          );
        }
        if (change === "membership") {
          await removeSessionMember(fixture.target, profile.id);
        }
      }
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath: state.configPath,
        token: "synthetic-replay-token",
      });
      await gateway.server.startupSettled;
      await expect(
        gateway.client.request("agent.wait", { runId: "replay-unchanged", timeoutMs: 30_000 }),
      ).resolves.toMatchObject({ status: "ok" });
      expect(providerErrors).toEqual([]);
      expect(requests).toHaveLength(2);
      expect(requests.every((body) => body.includes("REPLAY_UNCHANGED"))).toBe(true);
      expect(requests.join("\n")).not.toMatch(/REPLAY_ROLE|REPLAY_DEVICE|REPLAY_MEMBERSHIP/);
      expect(await fs.readFile(effectsPath, "utf8")).toBe("UNCHANGED_OPERATOR");
      for (const { change, fixture } of cases) {
        const pending = await listSessionPendingInputs(fixture.target);
        if (change === "unchanged") {
          expect(pending.items).toEqual([]);
        } else {
          expect(pending.items).toMatchObject([
            { runId: fixture.target.sourceRunId, state: "interrupted" },
          ]);
        }
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "chat replay authority proof complete" });
        }
      } finally {
        try {
          await closeProvider(providerServer);
        } finally {
          await state.cleanup();
        }
      }
    }
  },
);
