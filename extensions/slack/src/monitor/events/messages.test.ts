import type { App } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageHandler } from "../message-handler.js";
import { createInboundSlackTestContext } from "../message-handler/prepare.test-helpers.js";
import { createSlackSystemEventRouteResolver } from "../system-event-session.js";
import {
  createSlackSystemEventTestHarness,
  type SlackSystemEventTestOverrides,
} from "./system-event-test-harness.js";

const SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY = "openclawIngressLifecycle";

const { messageQueueMock, messageAllowMock, inboundInfoSpy, noteConversationMessageMock } =
  vi.hoisted(() => ({
    messageQueueMock: vi.fn(),
    messageAllowMock: vi.fn(),
    inboundInfoSpy: vi.fn(),
    noteConversationMessageMock: vi.fn(),
  }));

vi.mock("../../draft-message-boundaries.js", () => ({
  noteSlackDraftConversationMessage: (...args: unknown[]) => noteConversationMessageMock(...args),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  const makeLogger = () => {
    const logger = {
      subsystem: "test",
      isEnabled: () => true,
      trace: () => {},
      debug: () => {},
      info: inboundInfoSpy,
      warn: () => {},
      error: () => {},
      fatal: () => {},
      raw: () => {},
      child: () => logger,
    };
    return logger;
  };
  return { ...actual, createSubsystemLogger: () => makeLogger() };
});

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => messageQueueMock(text, { ...options, sessionKey: route.sessionKey }),
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => messageAllowMock(...args),
  };
});
vi.mock("openclaw/plugin-sdk/text-chunking", () => ({
  chunkItems: <T>(items: T[]) => [items],
  markdownToIR: (text: string) => text,
  renderMarkdownIRChunksWithinLimit: (text: string) => [text],
  renderMarkdownWithMarkers: (text: string) => text,
  sanitizeAssistantVisibleText: (text: string) => text,
  stripReasoningTagsFromText: (text: string) => text,
}));

let registerSlackMessageEvents: typeof import("./messages.js").registerSlackMessageEvents;

function inboundLogLines(): string[] {
  return inboundInfoSpy.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === "string" && line.startsWith("Inbound "));
}

type MessageHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
  context?: Record<string, unknown>;
  client?: object;
}) => Promise<void>;
type RegisteredEventName = "message" | "app_mention";

function createHandlers(eventName: RegisteredEventName, overrides?: SlackSystemEventTestOverrides) {
  const harness = createSlackSystemEventTestHarness(overrides);
  const handleSlackMessage = vi.fn<SlackMessageHandler>(async () => {});
  registerSlackMessageEvents({
    ctx: harness.ctx,
    handleSlackMessage,
  });
  return {
    ctx: harness.ctx,
    handler: requireMessageHandler(harness.getHandler(eventName) as MessageHandler | null),
    handleSlackMessage,
  };
}

function createEnterpriseHandlers(eventName: RegisteredEventName) {
  const handlers = createHandlers(eventName);
  handlers.ctx.installationIdentity = {
    kind: "enterprise",
    apiAppId: "A_TEST",
    enterpriseId: "E_TEST",
  };
  return handlers;
}

function requireMessageHandler(handler: MessageHandler | null): MessageHandler {
  if (!handler) {
    throw new Error("expected Slack message event handler");
  }
  return handler;
}

beforeAll(async () => {
  ({ registerSlackMessageEvents } = await import("./messages.js"));
});

beforeEach(() => {
  messageQueueMock.mockClear();
  messageAllowMock.mockReset().mockResolvedValue([]);
  noteConversationMessageMock.mockClear();
  inboundInfoSpy.mockClear();
});

const assistantBlocks = () => [
  {
    type: "data_visualization",
    title: "Latency",
    chart: {
      type: "line",
      series: [{ name: "p95", data: [{ label: "Mon", value: 250 }] }],
      axis_config: { categories: ["Mon"] },
    },
  },
];
const assistantThread = () => ({
  channel_id: "D1",
  thread_ts: "123.000",
  context: { channel_id: "C123", team_id: "T123" },
});

function makeAssistantChangedEvent() {
  return {
    type: "message",
    subtype: "message_changed",
    channel: "D1",
    channel_type: "im",
    user: "U_BOT",
    message: {
      ts: "123.456",
      thread_ts: "123.000",
      user: "U_BOT",
      text: "assistant wrapped user text",
      blocks: assistantBlocks(),
      metadata: { event_payload: { user: "UREAL123" } },
      assistant_thread: assistantThread(),
    },
    previous_message: { ts: "123.456", user: "U_BOT" },
    event_ts: "123.789",
  };
}

function makeThreadBroadcastEvent() {
  return {
    type: "message",
    subtype: "thread_broadcast",
    channel: "C123",
    user: "U123",
    message: { ts: "123.456", user: "U123" },
    event_ts: "123.456",
  };
}

function makeAppMentionEvent(channel = "C123") {
  return {
    type: "app_mention",
    channel,
    channel_type: "channel",
    user: "U1",
    text: "<@U_BOT> hello",
    ts: "123.456",
  };
}

async function invokeRegisteredHandler(input: {
  eventName: RegisteredEventName;
  overrides?: SlackSystemEventTestOverrides;
  event: Record<string, unknown>;
  body?: unknown;
}) {
  const { handler, handleSlackMessage } = createHandlers(input.eventName, input.overrides);
  await handler({
    event: input.event,
    body: input.body ?? {},
  });
  return { handleSlackMessage };
}

describe("registerSlackMessageEvents", () => {
  it("forwards durable ingress ownership and propagates dispatch failure", async () => {
    const harness = createSlackSystemEventTestHarness();
    const dispatchError = new Error("transient dispatch failure");
    const handleSlackMessage = vi.fn(async () => {
      throw dispatchError;
    });
    registerSlackMessageEvents({ ctx: harness.ctx, handleSlackMessage });
    const handler = requireMessageHandler(harness.getHandler("message") as MessageHandler | null);
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };

    await expect(
      handler({
        event: {
          type: "message",
          channel: "D1",
          channel_type: "im",
          user: "U1",
          text: "hello",
          ts: "123.456",
        },
        body: {},
        context: { [SLACK_INGRESS_LIFECYCLE_CONTEXT_KEY]: turnAdoptionLifecycle },
      }),
    ).rejects.toBe(dispatchError);

    expect(handleSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", ts: "123.456" }),
      expect.objectContaining({
        source: "message",
        awaitDispatch: true,
        turnAdoptionLifecycle,
      }),
    );
  });

  it("accepts two org workspaces and preserves each listener scope", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    const clients = [{ id: "one" }, { id: "two" }];
    for (const [index, teamId] of ["T111", "T222"].entries()) {
      await handler({
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "U123",
          text: "hello",
          ts: `123.${index}`,
        },
        body: { api_app_id: "A_TEST" },
        context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId },
        client: clients[index],
      });
    }

    expect(handleSlackMessage).toHaveBeenCalledTimes(2);
    const calls = handleSlackMessage.mock.calls as unknown as Array<
      [unknown, { awaitDispatch?: boolean; eventScope?: unknown }]
    >;
    expect(calls[0]?.[1]).toMatchObject({
      awaitDispatch: true,
      eventScope: { teamId: "T111", client: clients[0] },
    });
    expect(calls[1]?.[1]).toMatchObject({
      awaitDispatch: true,
      eventScope: { teamId: "T222", client: clients[1] },
    });
  });

  it("drops bot-authored enterprise app_mention events in favor of the message event", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("app_mention");
    await handler({
      event: { ...makeAppMentionEvent(), bot_id: "B_OTHER" },
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(inboundLogLines()).toEqual([]);
  });

  it("passes enterprise thread_broadcast through listener-scoped dispatch", async () => {
    const { handler, handleSlackMessage } = createEnterpriseHandlers("message");
    const event = {
      ...makeThreadBroadcastEvent(),
      bot_id: "B_OTHER",
    };
    const client = {};
    await handler({
      event,
      body: { api_app_id: "A_TEST" },
      context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T111" },
      client,
    });

    expect(handleSlackMessage).toHaveBeenCalledOnce();
    expect(handleSlackMessage).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        source: "message",
        awaitDispatch: true,
        eventScope: expect.objectContaining({ teamId: "T111", client }),
      }),
    );
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("rehydrates assistant DM message_changed events with a metadata user as inbound messages", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: makeAssistantChangedEvent(),
    });

    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    const call = handleSlackMessage.mock.calls.at(0);
    expect(call?.[0]).toMatchObject({
      channel: "D1",
      channel_type: "im",
      user: "UREAL123",
      text: "assistant wrapped user text",
      ts: "123.456",
      thread_ts: "123.000",
    });
    expect(noteConversationMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "D1",
        threadTs: "123.000",
        messageTs: "123.456",
        userId: "UREAL123",
      }),
    );
    expect(call?.[0]).toEqual(
      expect.objectContaining({ assistant_thread: assistantThread(), blocks: assistantBlocks() }),
    );
    expect(call?.[1]).toEqual({ source: "message" });
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it("drops self-authored message_changed events that only include block user IDs", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "message",
      overrides: { dmPolicy: "open" },
      event: {
        ...makeAssistantChangedEvent(),
        message: {
          ts: "123.456",
          user: "U_BOT",
          text: "preview edit with mention",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [{ type: "user", user_id: "UREAL123" }],
                },
              ],
            },
          ],
        },
      },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(messageQueueMock).not.toHaveBeenCalled();
  });

  it.each([
    { channelType: "channel", subtype: "message_deleted", threadSession: true },
    { channelType: "im", threadSession: false },
    { channelType: "channel", root: true, threadSession: false },
    {
      channelType: "channel",
      previousOnly: true,
      threadSession: true,
    },
    {
      channelType: "channel",
      root: true,
      parentUserId: "U_PARENT",
      threadSession: true,
    },
    { channelType: "mpim", denied: true, threadSession: false },
    {
      channelType: "channel",
      enterprise: true,
      threadSession: true,
    },
  ] as const)(
    "routes $channelType events to their actual conversation",
    async ({ channelType, threadSession, ...scenario }) => {
      const subtype = "subtype" in scenario ? scenario.subtype : "message_changed";
      const actualSystemEvents = await vi.importActual<
        typeof import("openclaw/plugin-sdk/system-event-runtime")
      >("openclaw/plugin-sdk/system-event-runtime");
      const { resetSystemEventsForTest } = await vi.importActual<
        typeof import("openclaw/plugin-sdk/test-fixtures")
      >("openclaw/plugin-sdk/test-fixtures");
      resetSystemEventsForTest();
      messageQueueMock.mockImplementation(
        (text: string, { sessionKey, ...options }: { sessionKey: string }) =>
          actualSystemEvents.enqueueRoutedSystemEvent(
            text,
            { agentId: "main", sessionKey },
            options,
          ),
      );

      const senderId = "U123";
      const denied = "denied" in scenario;
      const enterprise = "enterprise" in scenario;
      const harness = createSlackSystemEventTestHarness({
        channelType,
        ...(channelType === "mpim" ? { allowFrom: denied ? ["U_OTHER"] : [senderId] } : {}),
      });
      harness.ctx.cfg = { channels: { slack: { enabled: true } } };
      harness.ctx.channelsConfigKeys = [];
      if (enterprise) {
        harness.ctx.installationIdentity = {
          kind: "enterprise",
          apiAppId: "A_TEST",
          enterpriseId: "E_TEST",
        };
      }
      harness.ctx.resolveSlackSystemEventRoute = createSlackSystemEventRouteResolver({
        cfg: harness.ctx.cfg,
        accountId: harness.ctx.accountId,
        getTeamId: () => harness.ctx.teamId,
        mainKey: "agent:main:main",
        threadInheritParent: false,
        recallSlackChannelType: () => channelType,
      });
      registerSlackMessageEvents({ ctx: harness.ctx, handleSlackMessage: async () => {} });

      const threadTs = "1712345678.123456";
      const channelId = channelType === "im" ? "D123" : channelType === "mpim" ? "G123" : "C123";
      const nestedMessage = {
        ts: "root" in scenario ? threadTs : "1712345678.654321",
        thread_ts: threadTs,
        user: senderId,
        ...("parentUserId" in scenario ? { parent_user_id: scenario.parentUserId } : {}),
      };
      const event = {
        type: "message",
        subtype,
        channel: channelId,
        channel_type: channelType,
        previous_message: nestedMessage,
        event_ts: "1712345679.000000",
        ...(subtype === "message_changed"
          ? {
              message:
                "previousOnly" in scenario
                  ? { ts: nestedMessage.ts, user: senderId }
                  : nestedMessage,
            }
          : { deleted_ts: nestedMessage.ts }),
      };
      const listenerClient = {} as App["client"];
      await requireMessageHandler(harness.getHandler("message") as MessageHandler | null)({
        event,
        body: { api_app_id: "A_TEST", event_id: `Ev-${channelType}-${subtype}` },
        ...(enterprise
          ? {
              context: { isEnterpriseInstall: true, enterpriseId: "E_TEST", teamId: "T_GRID" },
              client: listenerClient,
            }
          : {}),
      });

      const eventScope = enterprise ? { teamId: "T_GRID", client: listenerClient } : undefined;
      const route = async (routeThreadTs?: string) =>
        (
          await harness.ctx.resolveSlackSystemEventRoute({
            channelId,
            channelType,
            senderId,
            eventScope,
            threadTs: routeThreadTs,
          })
        ).sessionKey;
      const parentSessionKey = await route();
      const threadSessionKey = await route(threadTs);

      expect(actualSystemEvents.peekSystemEventEntries(parentSessionKey)).toHaveLength(
        denied || threadSession ? 0 : 1,
      );
      expect(actualSystemEvents.peekSystemEventEntries(threadSessionKey)).toHaveLength(
        threadSession ? 1 : 0,
      );
      resetSystemEventsForTest();
    },
  );

  it("keeps bot edit and delete events on a remembered C-prefix mpDM session", async () => {
    const handlers: Record<string, MessageHandler> = {};
    const conversationsInfo = vi.fn().mockRejectedValue(new Error("missing_scope"));
    const app = {
      client: {
        conversations: { info: conversationsInfo },
        users: {
          info: vi.fn().mockResolvedValue({ user: { name: "other-agent" } }),
        },
      },
      event: (name: string, handler: MessageHandler) => {
        handlers[name] = handler;
      },
    } as unknown as App;
    const ctx = createInboundSlackTestContext({
      app,
      cfg: {
        channels: {
          slack: {
            enabled: true,
            groupPolicy: "open",
            allowFrom: ["*"],
            dm: { groupEnabled: true },
          },
        },
      },
      defaultRequireMention: false,
    });
    const handleSlackMessage = vi.fn(async () => {});
    registerSlackMessageEvents({ ctx, handleSlackMessage });
    const handler = requireMessageHandler(handlers.message ?? null);

    await handler({
      event: {
        type: "message",
        channel: "C0MPDM42",
        channel_type: "mpim",
        user: "U_HUMAN",
        text: "human seed",
        ts: "1.000",
      },
      body: {},
    });
    await handler({
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "C0MPDM42",
        message: { ts: "2.000", bot_id: "B_OTHER" },
        previous_message: { ts: "1.000", bot_id: "B_OTHER" },
        event_ts: "2.100",
      },
      body: {},
    });
    await handler({
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: "C0MPDM42",
        deleted_ts: "2.000",
        previous_message: { ts: "2.000", bot_id: "B_OTHER" },
        event_ts: "3.000",
      },
      body: {},
    });

    const sessionKeys = messageQueueMock.mock.calls.map(
      (call) => (call[1] as { sessionKey?: string }).sessionKey,
    );
    expect(sessionKeys).toEqual([
      "agent:main:slack:group:c0mpdm42",
      "agent:main:slack:group:c0mpdm42",
    ]);
    expect(handleSlackMessage).toHaveBeenCalledOnce();
    expect(conversationsInfo).toHaveBeenCalledTimes(2);
  });

  it("skips typeless app_mention events for metadata-resolved MPIM C0MPDM42", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open", channelType: "mpim" },
      event: { ...makeAppMentionEvent("C0MPDM42"), channel_type: undefined },
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    // Handled via message.mpim; must not log a duplicate receipt.
    expect(inboundLogLines()).toEqual([]);
  });

  it("uses a remembered MPIM type without loading channel metadata", async () => {
    const { ctx, handler, handleSlackMessage } = createHandlers("app_mention", {
      dmPolicy: "open",
    });
    const resolveChannelName = vi.fn(async () => ({ type: "channel" as const }));
    ctx.recallSlackChannelType = () => "mpim";
    ctx.resolveChannelName = resolveChannelName;

    await handler({
      event: { ...makeAppMentionEvent("C0MPDM42"), channel_type: undefined },
      body: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(resolveChannelName).not.toHaveBeenCalled();
    expect(inboundLogLines()).toEqual([]);
  });

  it("routes typeless app_mention after resolving group metadata", async () => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { channelType: "group" },
      event: { ...makeAppMentionEvent("G123"), channel_type: undefined },
    });

    expect(handleSlackMessage).toHaveBeenCalledOnce();
    expect(handleSlackMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "G123" }),
      expect.objectContaining({ source: "app_mention", wasMentioned: true }),
    );
  });

  it("logs a bounded diagnostic when typeless app_mention metadata lookup fails", async () => {
    const { ctx, handler, handleSlackMessage } = createHandlers("app_mention");
    ctx.resolveChannelName = () => Promise.reject(new Error("private lookup payload"));

    await handler({
      event: { ...makeAppMentionEvent(), channel_type: undefined },
      body: {},
    });

    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(inboundInfoSpy).toHaveBeenCalledWith(
      "Slack app_mention skipped: conversation type unresolved; channelId=C123 lookupFailureCategory=other; waiting for message event",
      { channelId: "C123", lookupFailureCategory: "other" },
    );
    expect(JSON.stringify(inboundInfoSpy.mock.calls)).not.toMatch(/private|hello/);
  });

  it.each([
    [
      "text",
      "Inbound app_mention slack:T_TEST:channel:C123:user:U1 -> bot:U_BOT (channel, 0 chars)",
    ],
    [
      "user",
      "Inbound app_mention slack:T_TEST:channel:C123:user:unknown -> bot:U_BOT (channel, 14 chars)",
    ],
  ])("logs channel app_mention receipts when %s is absent", async (field, receipt) => {
    const { handleSlackMessage } = await invokeRegisteredHandler({
      eventName: "app_mention",
      overrides: { dmPolicy: "open" },
      event: {
        ...makeAppMentionEvent(),
        [field]: undefined,
      },
    });
    expect(handleSlackMessage).toHaveBeenCalledTimes(1);
    expect(inboundLogLines()).toEqual([receipt]);
  });
});
