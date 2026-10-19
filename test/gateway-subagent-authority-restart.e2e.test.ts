import type { ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../packages/gateway-protocol/src/client-info.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

function writeTool(response: ServerResponse, name: string, args: Record<string, unknown>) {
  const item = {
    type: "function_call",
    id: `fc_${name}`,
    call_id: `call_${name}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${name}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

it.skipIf(process.platform === "win32")(
  "restores an identified parent's completion authority after a hard Gateway crash",
  { timeout: 600_000 },
  async () => {
    const sessionKey = "agent:main:subagent-authority-restart";
    let parentRequests = 0;
    let childRequests = 0;
    const model = await startOpenAiResponsesModelServer({
      modelId: "subagent-restart-proof",
      bindError: "model did not bind",
      onRequest: async (request, response) => {
        const body: unknown = await json(request);
        if (JSON.stringify(body).includes("PARENT_RESTART_TASK")) {
          parentRequests += 1;
          if (parentRequests === 1) {
            writeTool(response, "sessions_spawn", {
              task: "CHILD_RESTART_TASK: wait for the model response.",
              taskName: "restart_child",
              mode: "run",
              cleanup: "keep",
              completionTarget: "parent",
              context: "isolated",
            });
          } else if (parentRequests === 2) {
            writeTool(response, "sessions_yield", {});
          } else {
            writeOpenAiResponsesText(response, {
              text: "PARENT_RECOVERED",
              messageId: "msg_parent_recovered",
              responseId: "resp_parent_recovered",
            });
          }
        } else {
          childRequests += 1;
          // Keep the child in flight until its Gateway command is killed.
        }
      },
    });
    const instance = await createOpenClawTestInstance({
      name: "gateway-subagent-authority-restart",
      env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      startTimeoutMs: 300_000,
    });
    let client: GatewayClient | undefined;
    await runQaGatewayFixture(
      async () => {
        const config = createOpenAiResponsesModelConfig({
          baseUrl: model.baseUrl,
          providerId: "subagent-restart-proof",
          modelId: "subagent-restart-proof",
          reasoning: false,
          toolProfile: "minimal",
        });
        config.plugins = { enabled: false };
        config.tools = {
          allow: ["sessions_spawn", "sessions_yield", "sessions_send", "subagents"],
          codeMode: { enabled: false },
          toolSearch: false,
        };
        config.gateway = {
          mode: "local",
          bind: "loopback",
          port: instance.port,
          auth: { mode: "token", token: instance.gatewayToken },
          controlUi: { enabled: false },
        };
        await instance.state.writeConfig(config);
        const deviceIdentity = loadOrCreateDeviceIdentity({
          path: instance.state.path("restart-operator-device.sqlite"),
        });
        const connect = () =>
          acquireGatewayTestClient(
            {
              url: instance.url,
              token: instance.gatewayToken,
              deviceIdentity,
              clientName: GATEWAY_CLIENT_IDS.TUI,
              mode: GATEWAY_CLIENT_MODES.UI,
              scopes: ["operator.admin", "operator.read", "operator.write"],
            },
            { timeoutMs: 60_000, timeoutMessage: "connect timeout", closeMessage: "closed" },
          );
        await instance.startGateway();
        client = await connect();
        await client.request("agent", {
          sessionKey,
          message: "PARENT_RESTART_TASK",
          idempotencyKey: "subagent-authority-original",
        });
        await vi.waitFor(
          () => {
            expect({ childRequests, parentRequests }, instance.logs()).toEqual({
              childRequests: 1,
              parentRequests: 2,
            });
          },
          { timeout: 60_000 },
        );
        const parentClient = client;
        await vi.waitFor(
          async () => {
            const history = await parentClient.request("chat.history", { sessionKey });
            expect(JSON.stringify(history), instance.logs()).toContain("yielded");
          },
          { timeout: 60_000 },
        );
        await client.stopAndWait();
        client = undefined;
        await instance.crashGateway();
        await instance.startGateway();
        client = await connect();
        await vi.waitFor(() => expect(parentRequests, instance.logs()).toBe(3), {
          timeout: 60_000,
        });
        const observer = client;
        await vi.waitFor(
          async () => {
            const sessions = await observer.request<SessionsListResult>("sessions.list", {
              agentId: "main",
            });
            expect(
              sessions.sessions.find((row) => row.key === sessionKey),
              instance.logs(),
            ).toMatchObject({ status: "done", hasActiveRun: false });
            const history = await observer.request<{ messages: unknown[] }>("chat.history", {
              sessionKey,
            });
            expect(
              history.messages
                .map(extractAssistantPhaseText)
                .filter((text) => text === "PARENT_RECOVERED"),
              instance.logs(),
            ).toHaveLength(1);
          },
          { timeout: 60_000 },
        );
      },
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      () => model.close(),
    );
  },
);
