import type { Message } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  captureAgentLoop,
  config,
  createTurnSequenceStream,
  makeCall,
  makeTool,
  model,
  user,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { Agent } from "../../../../packages/agent-core/src/agent.js";
import { REPEATED_TOOL_ERROR_CODE } from "../../../../packages/agent-core/src/errors.js";
import { setInternalBeforeToolBatch } from "../../../../packages/agent-core/src/internal-hooks.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

function failingTool(message = "same failure") {
  const tool = makeTool("probe");
  tool.execute = async () => {
    throw new Error(message);
  };
  return tool;
}

function runTurns(
  tools: ReturnType<typeof makeTool>[],
  turns: Parameters<typeof createTurnSequenceStream>[0],
  options: Partial<typeof config> = {},
  requests?: Message[][],
) {
  return captureAgentLoop(
    [user()],
    { systemPrompt: "", messages: [], tools },
    { ...config, beforeToolBatch: createToolLoopBatchAdmission({}), ...options },
    undefined,
    createTurnSequenceStream(turns, requests),
  );
}

function makeAgent(options: ConstructorParameters<typeof Agent>[0]) {
  const agent = new Agent(options);
  setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission({}));
  return agent;
}

describe("default repeated tool error termination", () => {
  it("records a terminal failure after three identical errors with loop detection enabled", async () => {
    const requests: Message[][] = [];
    const run = runTurns(
      [failingTool("resource unavailable")],
      [
        ...Array.from({ length: 3 }, (_, index) => [makeCall("probe", `call-${index}`)]),
        [{ type: "text", text: "[tool error]" }],
      ],
      {
        beforeToolBatch: createToolLoopBatchAdmission({
          sessionKey: "repeat-error-true",
          runId: "repeat-error-true",
          loopDetection: { enabled: true },
        }),
      },
      requests,
    );
    const messages = await run.result;
    expect(requests).toHaveLength(3);
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorCode: REPEATED_TOOL_ERROR_CODE,
      errorMessage: expect.stringContaining("3 consecutive"),
      content: [{ type: "text", text: expect.stringContaining("native tool calling") }],
    });
    expect(run.events.at(-1)).toMatchObject({ type: "agent_end", messages });
  });

  it("preserves successful retry", async () => {
    let calls = 0;
    const tool = makeTool("probe");
    tool.execute = async () => {
      calls++;
      if (calls === 2) {
        return { content: [{ type: "text", text: `progress ${calls}` }], details: {} };
      }
      throw new Error("same error");
    };
    const turns = Array.from({ length: 4 }, (_, index) => [makeCall(tool.name, `call-${index}`)]);
    const run = runTurns([tool], [...turns, [{ type: "text", text: "done" }]], {
      beforeToolBatch: createToolLoopBatchAdmission({
        sessionKey: "successful retry",
        runId: "successful retry",
      }),
    });
    expect((await run.result).at(-1)).toMatchObject({ stopReason: "stop" });
    expect(calls).toBe(4);
  });

  it.each(["unknown name", "returned failure"])(
    "terminates repeated %s outcomes without another provider request",
    async (failure) => {
      const tool = makeTool("probe");
      tool.execute = async () => {
        return {
          content: [{ type: "text", text: "Resource unavailable" }],
          details: { status: "error" },
        };
      };
      const run = runTurns(
        failure === "unknown name" ? [] : [tool],
        Array.from({ length: 3 }, (_, index) => [makeCall("probe", `call-${index}`)]),
      );
      expect((await run.result).at(-1)).toMatchObject({ stopReason: "error" });
    },
  );

  it.each(["sequential", "parallel"] as const)(
    "settles the %s batch when the third error ends the turn",
    async (toolExecution) => {
      let calls = 0;
      const tool = makeTool("probe");
      tool.execute = async () => {
        calls++;
        throw new Error("same failure");
      };
      const run = runTurns(
        [tool],
        [Array.from({ length: 5 }, (_, index) => makeCall("probe", `call-${index}`))],
        { toolExecution },
      );
      const messages = await run.result;
      expect(calls).toBe(toolExecution === "sequential" ? 3 : 5);
      expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(5);
      expect(messages.at(-1)).toMatchObject({ stopReason: "error" });
    },
  );

  it("counts parallel results in assistant order despite a successful call settling first", async () => {
    const releaseFailures = createDeferred();
    const tool = makeTool("probe");
    tool.execute = async (id) => {
      if (id === "success") {
        return { content: [{ type: "text", text: "progress" }], details: {} };
      }
      await releaseFailures.promise;
      throw new Error("same failure");
    };
    const completed: string[] = [];
    const agent = makeAgent({
      initialState: { model, tools: [tool] },
      streamFn: createTurnSequenceStream([
        ["first", "second", "success", "fourth", "fifth"].map((id) => makeCall("probe", id)),
        [{ type: "text", text: "done" }],
      ]),
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        completed.push(event.toolCallId);
        if (event.toolCallId === "success") {
          releaseFailures.resolve();
        }
      }
    });
    await agent.prompt("start");
    expect(completed[0]).toBe("success");
    expect(completed).toHaveLength(5);
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  });

  it("keeps failure evidence across continue and resets it for a fresh prompt", async () => {
    const agent = makeAgent({
      initialState: { model, tools: [failingTool()] },
      convertToLlm: config.convertToLlm,
      streamFn: createTurnSequenceStream([
        [makeCall("probe", "first")],
        [makeCall("probe", "second")],
      ]),
      afterToolOutcome: async () => ({ terminate: true }),
    });
    await agent.prompt("start");
    await agent.continue();
    agent.streamFn = createTurnSequenceStream([[makeCall("probe", "third")]]);
    await agent.continue();
    expect(agent.state.messages.at(-1)).toMatchObject({ stopReason: "error" });

    agent.streamFn = createTurnSequenceStream([[makeCall("probe", "fresh")]]);
    await agent.prompt("try again");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "toolResult" });
    expect(agent.state.errorMessage).toBeUndefined();
  });

  it.each([
    { queue: "followUp", delivery: "active" },
    { queue: "followUp", delivery: "continue" },
    { queue: "steer", delivery: "active" },
    { queue: "steer", delivery: "continue" },
  ] as const)(
    "starts a fresh error streak for $queue through $delivery",
    async ({ queue, delivery }) => {
      const freshInput = user("second request", 2);
      const agent = makeAgent({
        initialState: { model, tools: [failingTool()] },
        streamFn: createTurnSequenceStream([
          [makeCall("probe", "first")],
          [makeCall("probe", "second")],
          ...(queue === "steer" && delivery === "active"
            ? []
            : [[{ type: "text" as const, text: "first answer" }]]),
          [makeCall("probe", "third")],
          [{ type: "text", text: "second answer" }],
        ]),
      });
      if (delivery === "active") {
        agent.subscribe((event) => {
          if (
            event.type === "message_end" &&
            event.message.role === "toolResult" &&
            event.message.toolCallId === "second"
          ) {
            agent[queue](freshInput);
          }
        });
      }
      await agent.prompt("first request");
      if (delivery === "continue") {
        agent[queue](freshInput);
        await agent.continue();
      }
      expect(agent.state.messages).toContain(freshInput);
      expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(
        3,
      );
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "second answer" }],
      });
      expect(agent.state.errorMessage).toBeUndefined();
    },
  );
});
