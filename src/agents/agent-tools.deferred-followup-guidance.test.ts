/** Tests model-facing descriptions selected from the final authorized tool set. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tool-metadata.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { applyToolAvailabilityDescriptions } from "./agent-tools.deferred-followup.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getChannelAgentToolMeta, setChannelAgentToolMeta } from "./channel-tool-metadata.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import {
  describeSessionsSearchTool,
  describeSessionsSendTool,
  describeSessionsSpawnTool,
} from "./tool-description-presets.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { createConversationsSendTool } from "./tools/conversation-tools.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

function tool(name: string, description = "available"): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: {} }),
  };
}

function describeTools(...tools: AnyAgentTool[]) {
  return applyToolAvailabilityDescriptions(tools);
}

describe("createOpenClawCodingTools availability guidance", () => {
  it.each([false, true])(
    "directs inter-session messages only to an available sessions_send (available=%s)",
    (hasSessionsSend) => {
      const [described] = describeTools(
        createSessionsYieldTool(),
        ...(hasSessionsSend ? [tool("sessions_send")] : []),
      );

      expect(described?.description).toContain("Does not message other sessions");
      expect(described?.description.includes("use sessions_send")).toBe(hasSessionsSend);
    },
  );

  it.each([
    { available: [], mode: "suggest", deferred: false },
    { available: ["sessions_yield", "agents_wait"], mode: "prefer", deferred: true },
  ] as const)(
    "separates collector waits from announcing yields: $available $mode deferred=$deferred",
    ({ available, mode, deferred }) => {
      const availableNames = new Set<string>(available);
      const toolOptions = {
        config: {
          agents: { entries: { main: {} } },
          tools: { swarm: true },
        },
        agentSessionKey: "agent:main:main",
      };
      const spawn = createSessionsSpawnTool(toolOptions);
      const tools = applyToolAvailabilityDescriptions([
        spawn,
        ...available.map((name) =>
          name === "sessions_yield"
            ? createSessionsYieldTool()
            : createAgentsWaitTool({ ...toolOptions, agentId: "main" }),
        ),
      ]);
      const toolNames = tools.map((entry) => entry.name);
      const prompt = buildAgentSystemPrompt({
        workspaceDir: "/tmp/openclaw",
        subagentDelegationMode: mode,
        toolNames: deferred ? ["tool_search"] : toolNames,
        capabilityToolNames: deferred ? toolNames : [],
      });
      const guidance = [prompt, ...tools.map((entry) => entry.description)].join("\n");
      expect.soft(guidance).not.toContain("completion push-based.");
      expect.soft(guidance).not.toContain("Need results before reply: `sessions_yield`");
      expect
        .soft(guidance)
        .not.toContain("End turn after subagent spawn; results arrive next message");
      for (const name of ["agents_wait", "sessions_yield"] as const) {
        expect(guidance.includes(name)).toBe(availableNames.has(name));
      }
      if (availableNames.has("agents_wait")) {
        expect.soft(guidance).toMatch(/collector[^.\n]*no completion notification/i);
        expect(guidance).toMatch(/await with agents_wait/);
        for (const field of ["collect", "outputSchema", "groupId"]) {
          expect(spawn.parameters).toHaveProperty(`properties.${field}`);
        }
      } else {
        for (const field of ["collect", "outputSchema", "groupId"]) {
          expect(spawn.parameters).not.toHaveProperty(`properties.${field}`);
        }
        expect(guidance).not.toContain("collect=true");
      }
    },
  );

  it("uses canonical automation guidance for the retained cron alias", () => {
    const tools = withMockedPlatform("linux", () =>
      describeTools(...["exec", "process", "cron"].map((name) => tool(name))),
    );
    const [exec, process] = tools;

    expect(tools.map((entry) => entry.name)).toEqual(["exec", "process", "cron"]);
    expect(exec?.description).toBe(
      "Run shell now; background continuation supported. Completed calls return command output directly. Use process only when exec reports running with a sessionId; output text alone is not a process handle. Long run: automatic completion wake when enabled and output/failure occurs; otherwise process confirms completion. Omit host/node to use the session's configured host. No sleep loops for reminders/follow-ups; use automations. TTY CLI/UI/coding agent: pty=true. Quote arguments containing shell metacharacters, including URL query strings with `?` or `&`.",
    );
    expect(process?.description).toBe(
      "Control existing exec: list, poll, log, write, send-keys, submit, paste, kill. poll/log: status, output, quiet success, completion without auto-wake, input hints. Others: input/intervention. No polling as timer/reminder; scheduled follow-up uses automations.",
    );
  });

  it("preserves plugin and channel ownership when replacing descriptions", () => {
    const originalTool = tool("process", "plugin process");
    setPluginToolMeta(originalTool, { pluginId: "example", optional: false });
    setChannelAgentToolMeta(originalTool as never, { channelId: "example-channel" });

    const [updated] = applyToolAvailabilityDescriptions([originalTool]);

    expect(updated).not.toBe(originalTool);
    expect(getPluginToolMeta(expectDefined(updated, "updated test invariant"))).toEqual({
      pluginId: "example",
      optional: false,
    });
    expect(getChannelAgentToolMeta(updated as never)).toEqual({
      channelId: "example-channel",
    });
  });

  it("mentions sessions_spawn only when it survives tool filtering", () => {
    const withoutSpawn = describeTools(tool("agents_list"), tool("agents_wait"));
    const withSpawn = describeTools(...withoutSpawn, tool("sessions_spawn"));

    for (const entry of withoutSpawn) {
      expect(entry.description).not.toContain("sessions_spawn");
    }
    for (const entry of withSpawn.filter((candidate) => candidate.name !== "sessions_spawn")) {
      expect(entry.description).toContain("sessions_spawn");
    }
  });

  it.each([false, true])(
    "describes only executable conversation routes (allowThreadTargets=%s)",
    (allowThreadTargets) => {
      const [described] = describeTools(
        tool("sessions_send", describeSessionsSendTool({ allowThreadTargets })),
        tool("conversations_list"),
        tool("conversations_send"),
      );

      expect(described?.description).toContain("conversations_list");
      expect(described?.description).toContain("conversations_send");
      expect(described?.description).not.toContain("conversations_turn");
    },
  );

  it("keeps authorized history guidance and the prepared session URL", () => {
    const sessionLinkBase = "https://gateway.example/control";
    const [described] = describeTools(
      tool("sessions_search", describeSessionsSearchTool({ sessionLinkBase })),
      tool("sessions_history"),
    );

    expect(described?.description).toContain("Search visible past sessions");
    expect(described?.description).toContain("sessions_history");
    expect(described?.description).toContain(`${sessionLinkBase}/chat/<agentId>`);
    expect(described?.description.indexOf("Follow up with sessions_history")).toBeLessThan(
      described?.description.indexOf("When pointing the user at a session") ?? Infinity,
    );
  });

  it("restores conversation lookup guidance only when lookup is authorized", () => {
    const [described] = describeTools(createConversationsSendTool(), tool("conversations_list"));

    expect(described?.description).toBe(
      "Send directly through a conversationRef from conversations_list. This performs channel delivery; it does not run the local agent in the backing session.",
    );
  });

  it("keeps only authorized spawn follow-ups without losing prepared runtime facts", () => {
    const [described] = describeTools(
      tool(
        "sessions_spawn",
        describeSessionsSpawnTool({
          acpAvailable: false,
          threadAvailable: true,
          sessionToolsVisibility: "self",
          swarmEnabled: true,
        }),
      ),
      tool("agents_list"),
      tool("sessions_history"),
    );

    expect(described?.description).toContain("configured agent (see agents_list);");
    expect(described?.description).toContain("sessions_history");
    expect(described?.description).not.toContain("agents_wait");
    expect(described?.description).not.toContain("`subagents`");
    expect(described?.description).toContain("persistent/thread-bound");
    expect(described?.description).toContain("(self: current session only)");
    expect(described?.description).not.toContain('runtime="acp"');
    // Transcript access alone does not expose execution/delivery diagnostics.
    expect(described?.description).not.toContain("When diagnosing a missing result");
  });

  it("preserves original inline spawn guidance when every follow-up remains available", () => {
    const [described] = describeTools(
      createSessionsSpawnTool({ config: { tools: { swarm: true } } }),
      createAgentsWaitTool({}),
      ...["agents_list", "subagents", "sessions_history"].map((name) => tool(name)),
    );

    expect(described?.description).toContain(
      "Execute work directly by default. Delegate a bounded, independent task only when parallel execution or an independent review provides a concrete benefit. Keep dependent steps with the same owner. Once delegation is appropriate, use a hidden subagent unless the user needs to revisit or steer deliberately supervised child work. This includes substantial, bounded API/service investigations that can be handed off with the needed context and capabilities. For hidden subagents, omit `visible` or set it false, and report results through the parent.",
    );
    expect(described?.description).not.toContain("trial-and-error");
    expect(described?.description).toContain("configured agent (see agents_list);");
    expect(described?.description).toContain("`groupId` groups a batch; await with agents_wait.");
    expect(described?.description).toContain(
      "(all: all sessions, cross-agent per tools.agentToAgent)",
    );
    expect(described?.description).toContain(
      "No spawn for quick lookup/single read. Check spawns via `subagents`/`sessions_history`. After spawn,",
    );
    expect(described?.description).toContain(
      "When diagnosing a missing result from an announcing child, use `subagents` to inspect execution and delivery status. Recover existing results or follow up within the still-authorized task; respect intentional cancellation and never loop-poll.",
    );
  });

  it("names exec for file listing only when exec survives tool filtering", () => {
    const nodes = createNodesTool();
    const [withoutExec] = describeTools(nodes);
    const [withExec] = describeTools(nodes, tool("exec"));

    expect(withoutExec?.description).toContain("fs.listDir returns sub-directories only");
    expect(withoutExec?.description).not.toContain("use the exec tool with host=node");
    expect(withExec?.description).toContain(
      "fs.listDir returns sub-directories only; use the exec tool with host=node to list files",
    );
    const invokeCommand = (
      expectDefined(withoutExec, "nodes tool").parameters as {
        properties?: Record<string, { description?: string }>;
      }
    ).properties?.invokeCommand;
    expect(invokeCommand?.description).toContain("fs.listDir returns sub-directories only");
    expect(invokeCommand?.description).not.toContain("use the exec tool");
  });
});
