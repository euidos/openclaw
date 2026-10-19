import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitToolResultMessage } from "../../../../packages/agent-core/src/agent-stream-response.js";
import { createToolExecutionErrorResult } from "../../../../packages/agent-core/src/tool-call-outcome.js";
import { validateScriptFileForShellBleed } from "../../bash-tools.exec-script-preflight.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "../../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { resolveEmbeddedRunTerminal } from "./terminal-resolution.js";
import { makeTerminalInput, type TerminalInput } from "./terminal-resolution.test-support.js";
import { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";

// mock-isolation: terminal recovery must not update persistent auth-profile state.
vi.mock("./auth-profile-success.js", () => ({
  markEmbeddedRunAuthProfileSuccess: vi.fn(),
  reportEmbeddedRunSuccessfulAuthBinding: vi.fn(),
}));

const REJECTED_TOOL_CALL_MESSAGE = "Provider returned an incomplete or malformed tool call";

function execAssistant(id: string) {
  return buildEmbeddedRunnerAssistant({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
  });
}

// A completed exec followed by a malformed call removed by the transport before dispatch.
function rejectedCallAfterSettledTool(
  overrides: Parameters<typeof makeEmbeddedRunnerAttempt>[0] = {},
  assistantOverrides: Parameters<typeof buildEmbeddedRunnerAssistant>[0] = {},
) {
  const assistant = buildEmbeddedRunnerAssistant({
    api: "openai-completions",
    provider: "meterkey",
    model: "deepseek/deepseek-v4-flash",
    stopReason: "error",
    errorMessage: REJECTED_TOOL_CALL_MESSAGE,
    content: [],
    ...assistantOverrides,
  });
  const attempt = makeEmbeddedRunnerAttempt({
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    toolMetas: [{ toolName: "exec", toolCallId: "call_exec", meta: "git log" }],
    itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
    ...overrides,
  });
  return {
    attempt,
    attemptAssistant: assistant,
    activeErrorContext: { provider: "meterkey", model: "deepseek/deepseek-v4-flash" },
    modelApi: "openai-completions",
    payloadsWithToolMedia: buildEmbeddedRunPayloads({
      assistantTexts: attempt.assistantTexts,
      lastAssistant: assistant,
      currentAssistant: assistant,
      sessionKey: "session:rejected-tool-call",
    }),
  } satisfies Partial<TerminalInput>;
}

async function refusedExecResult(toolCallId = "call_exec") {
  const result = await validateScriptFileForShellBleed({
    command: "cat bad.py | python",
    workdir: "/tmp",
  }).then(
    () => {
      throw new Error("Expected script-preflight refusal");
    },
    (error: unknown) => createToolExecutionErrorResult(error),
  );
  return emitToolResultMessage(
    {
      toolCall: { type: "toolCall", id: toolCallId, name: "exec", arguments: {} },
      result,
      isError: true,
    },
    () => undefined,
  );
}

async function refusedExecThenRejectedCall() {
  const failure: ToolErrorSummary = {
    toolName: "exec",
    executionStarted: false,
    mutatingAction: false,
  };
  const failedTool = {
    toolName: "exec",
    toolCallId: "call_exec",
    isError: true,
    asyncStarted: false,
  };
  const turn = rejectedCallAfterSettledTool(
    {
      lastToolError: failure,
      toolMetas: [failedTool],
    },
    {
      api: "anthropic-messages",
      provider: "anthropic",
      errorCode: "malformed_tool_call_arguments",
      errorMessage: "Provider completed tool call with malformed JSON arguments",
    },
  );
  const failedResult = await refusedExecResult();
  turn.attempt.messagesSnapshot = [
    { role: "user", content: "Inspect the workspace", timestamp: 0 },
    execAssistant("call_exec"),
    failedResult,
    turn.attemptAssistant,
  ];
  return { ...turn, failure, failedTool, failedResult, modelApi: "anthropic-messages" };
}

function terminalCase(turn: Partial<TerminalInput>, overrides: Partial<TerminalInput> = {}) {
  const activateInternalPrompt = vi.fn();
  const input = makeTerminalInput({
    ...turn,
    ...overrides,
    sessionPromptState: { activateInternalPrompt },
  });
  return { activateInternalPrompt, resolve: () => resolveEmbeddedRunTerminal(input) };
}

function prependFailedExec(
  turn: Awaited<ReturnType<typeof refusedExecThenRejectedCall>>,
  result: Awaited<ReturnType<typeof refusedExecResult>>,
) {
  turn.attempt.messagesSnapshot.splice(1, 0, execAssistant(result.toolCallId), result);
  turn.attempt.toolMetas.unshift({
    toolName: "exec",
    toolCallId: result.toolCallId,
    isError: true,
  });
  turn.attempt.itemLifecycle = { startedCount: 2, completedCount: 2, activeCount: 0 };
}

describe("terminal resolution for a tool call rejected before dispatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("continues once after settled tools instead of replaying the attempt", async () => {
    const turn = rejectedCallAfterSettledTool();
    expect(turn.attempt.replayMetadata.hadPotentialSideEffects).toBe(true);
    const { resolve, activateInternalPrompt } = terminalCase(turn);
    await expect(resolve()).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
    const instruction = activateInternalPrompt.mock.calls[0]?.[0] as string;
    expect(instruction).toContain("rejected before it ran");
    expect(instruction).toContain("Do not repeat completed tool calls");

    const exhausted = await terminalCase(turn, {
      retryState: { ...createEmbeddedRunTerminalRetryState(), emptyResponseAttempts: 1 },
    }).resolve();
    expect(exhausted.action).toBe("complete");
    if (exhausted.action !== "complete") {
      return;
    }
    expect(exhausted.result.meta.error).toMatchObject({ kind: "incomplete_turn" });
  });

  it("continues once after a consumed exec refusal and a malformed different call", async () => {
    const turn = await refusedExecThenRejectedCall();
    const { resolve, activateInternalPrompt } = terminalCase(turn, {
      retryState: createEmbeddedRunTerminalRetryState(),
    });

    await expect(resolve()).resolves.toEqual({ action: "retry" });
    expect(activateInternalPrompt).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Do not repeat completed tool calls"),
    );
    expect(turn.attempt.lastToolError).toEqual({
      toolName: "exec",
      executionStarted: false,
      mutatingAction: false,
    });
    expect((await resolve()).action).toBe("complete");
    expect(activateInternalPrompt).toHaveBeenCalledOnce();
  });

  it("continues after multiple consumed preflight refusals", async () => {
    const turn = await refusedExecThenRejectedCall();
    prependFailedExec(turn, await refusedExecResult("call_earlier"));

    await expect(terminalCase(turn).resolve()).resolves.toEqual({ action: "retry" });
  });

  it.each<[string, (turn: Awaited<ReturnType<typeof refusedExecThenRejectedCall>>) => void]>([
    ["started", ({ failure }) => Object.assign(failure, { executionStarted: true })],
    [
      "unknown",
      ({ failure }) => {
        delete failure.executionStarted;
      },
    ],
    ["missing-result", ({ attempt }) => attempt.messagesSnapshot.splice(2, 1)],
    [
      "unconsumed",
      ({ attempt, failedResult }) => {
        attempt.messagesSnapshot.splice(2, 1);
        attempt.messagesSnapshot.push(failedResult);
      },
    ],
    [
      "prior-turn",
      ({ attempt }) =>
        attempt.messagesSnapshot.splice(3, 0, { role: "user", content: "New task", timestamp: 1 }),
    ],
    ["different-tool", ({ failure }) => Object.assign(failure, { toolName: "write" })],
    [
      "earlier-failure",
      (turn) =>
        prependFailedExec(turn, {
          role: "toolResult",
          toolCallId: "call_earlier",
          toolName: "exec",
          content: [{ type: "text", text: "Command failed after starting" }],
          isError: true,
          timestamp: 0,
        }),
    ],
    ["active", ({ attempt }) => Object.assign(attempt.itemLifecycle, { activeCount: 1 })],
    ["async", ({ failedTool }) => Object.assign(failedTool, { asyncStarted: true })],
  ])("does not continue a %s tool failure", async (_condition, alter) => {
    const turn = await refusedExecThenRejectedCall();
    alter(turn);
    const { resolve, activateInternalPrompt } = terminalCase(turn);
    const result = await resolve();
    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });

  it("does not continue after an unrelated provider error", async () => {
    const { resolve, activateInternalPrompt } = terminalCase(
      rejectedCallAfterSettledTool({}, { errorMessage: "upstream connect error" }),
    );
    const result = await resolve();

    expect(result.action).toBe("complete");
    expect(activateInternalPrompt).not.toHaveBeenCalled();
  });
});
