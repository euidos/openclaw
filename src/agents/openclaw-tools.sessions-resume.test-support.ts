import { Value } from "typebox/value";
import { expect, it, type Mock } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readInProcessSubagentResume } from "../gateway/in-process-subagent-resume.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { subagentRuns } from "./subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagents/registry/subagent-registry-persistence.js";
import { addSubagentRunForTests } from "./subagents/registry/subagent-registry.test-helpers.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

type SessionsSendResumeFixtures = {
  getSessionTool: (name: "sessions_send", options: { agentSessionKey: string }) => AnyAgentTool;
  callGatewayMock: Mock;
};
const parent = "agent:main:main";
const admitted = <T>(runId: string, execute: () => T) =>
  withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: parent,
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      receiptAuthority: () => true,
    },
    execute,
  );

export function registerSessionsSendResumeTests({
  getSessionTool,
  callGatewayMock,
}: SessionsSendResumeFixtures) {
  it("sessions_send resume rejects a caller without admitted authority instead of sending a message", async () => {
    const tool = getSessionTool("sessions_send", { agentSessionKey: parent });
    const result = await tool.execute("resume", {
      sessionKey: "agent:main:dashboard:paused-child",
      message: "Continue the assigned task",
      mode: "resume",
    });
    expect(result.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("admitted"),
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each([
    ["explicit resume", { mode: "resume" }],
    ["newer completed sibling", {}],
    ["automatic resume with reply options", { timeoutSeconds: 30, watch: true }],
    ["explicit separate followup", { mode: "followup" }],
    ["unrelated caller", {}],
    ["completion unspecified", {}],
  ] as const)("sessions_send preserves completion ownership: %s", async (scenario, options) => {
    const targetKey = `agent:main:${scenario === "explicit resume" ? "subagent" : "dashboard"}:resume-child`;
    const previousRunId = "tool-resume-paused";
    const siblingRunId = "tool-resume-independent-sibling";
    const controller =
      scenario === "unrelated caller" ? "agent:main:dashboard:other-parent" : parent;
    const pauseReason = "sessions_yield";
    const resumes =
      scenario !== "explicit separate followup" &&
      scenario !== "unrelated caller" &&
      scenario !== "completion unspecified";
    const childSessionIdentity = {
      sessionId: "tool-resume-session",
      lifecycleRevision: "tool-resume-revision",
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: targetKey },
      { ...childSessionIdentity, updatedAt: Date.now() },
    );
    await addSubagentRunForTests({
      runId: previousRunId,
      childSessionKey: targetKey,
      childSessionIdentity,
      requesterSessionKey: controller,
      requesterDisplayKey: controller,
      controllerSessionKey: controller,
      task: "Wait",
      cleanup: "keep",
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      pauseReason,
      expectsCompletionMessage: scenario === "completion unspecified" ? undefined : true,
    });
    if (scenario === "newer completed sibling") {
      await addSubagentRunForTests({
        runId: siblingRunId,
        childSessionKey: targetKey,
        childSessionIdentity,
        requesterSessionKey: "agent:main:dashboard:separate-requester",
        requesterDisplayKey: "separate-requester",
        controllerSessionKey: parent,
        task: "Independent follow-up",
        cleanup: "keep",
        generation: 2,
        createdAt: Date.now() + 1,
        execution: { status: "terminal", endedAt: Date.now() + 1, outcome: { status: "ok" } },
      });
    }
    callGatewayMock.mockImplementation(async ({ method }) => {
      if (method === "agent") {
        return {
          status: "accepted",
          runId: "tool-resume-successor",
          ...(resumes ? { taskRunId: previousRunId } : {}),
        };
      }
      return method === "agent.wait"
        ? { status: "ok", terminalReply: { disposition: "empty" } }
        : {};
    });
    const tool = getSessionTool("sessions_send", { agentSessionKey: parent });
    try {
      const result = await admitted("parent-turn", () =>
        tool.execute("resume", { sessionKey: targetKey, message: "Continue", ...options }),
      );
      expect(result.details).toEqual(
        resumes
          ? {
              status: "accepted",
              mode: "resume",
              runId: "tool-resume-successor",
              taskRunId: previousRunId,
              sessionKey: targetKey,
              completion: "task",
            }
          : {
              status: "no_reply",
              runId: "tool-resume-successor",
              sessionKey: targetKey,
              message: expect.any(String),
            },
      );
      expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
      const callsFor = (method: string) =>
        callGatewayMock.mock.calls.filter(([request]) => request.method === method);
      expect(callsFor("agent")).toHaveLength(1);
      expect(callsFor("agent.wait")).toHaveLength(resumes ? 0 : 1);
      const request = callsFor("agent")[0]?.[0];
      if (resumes) {
        expect(readInProcessSubagentResume(request)).toMatchObject({
          previousRunId,
          childSessionKey: targetKey,
          childSessionId: "tool-resume-session",
        });
        expect(request.params).toMatchObject({
          expectedExistingSessionId: "tool-resume-session",
        });
      } else {
        expect(readInProcessSubagentResume(request)).toBeUndefined();
        expect(request.params).toMatchObject({ sessionKey: targetKey });
      }
      expect(request.params).not.toHaveProperty("subagentResume");
      expect(subagentRuns.get(previousRunId)).toMatchObject({
        pauseReason,
        requesterSessionKey: controller,
        controllerSessionKey: controller,
      });
    } finally {
      await mutateSubagentRuns([previousRunId, siblingRunId], (rows) => ({
        value: undefined,
        postimages: new Map([...rows.keys()].map((runId) => [runId, null])),
      }));
    }
  });

  it("sessions_send resume rejects competing delivery options", async () => {
    const tool = getSessionTool("sessions_send", { agentSessionKey: parent });
    await expect(
      admitted("parent-options-turn", () =>
        tool.execute("resume-options", {
          sessionKey: "agent:main:subagent:child",
          message: "Continue",
          mode: "resume",
          timeoutSeconds: 1,
        }),
      ),
    ).rejects.toThrow("admission only");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
}
