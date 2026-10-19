import "../test-utils/prepare-compiled-subprocesses.js";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";

let createOpenClawCodingTools: typeof import("./agent-tools.js").createOpenClawCodingTools;

const { mockExecApprovals, supervisorSpawnMock } = await vi.hoisted(async () => {
  const { resolveExecApprovalsFromFileInternal } =
    await import("../infra/exec-approvals-resolver.js");
  const { runtimeManagedRun } = await import("./bash-tools.exec-runtime.test-support.js");
  return {
    mockExecApprovals: resolveExecApprovalsFromFileInternal({
      path: "/tmp/exec-approvals.json",
      file: {
        version: 1,
        socket: { path: "/tmp/exec-approvals.sock", token: "token" },
        defaults: {
          security: "allowlist",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {},
      },
    }),
    supervisorSpawnMock: vi.fn(async (input: SpawnInput) => ({
      ...runtimeManagedRun(input, `${"argv" in input ? (input.argv?.join(" ") ?? "") : ""}\n`),
      runId: "safe-bins-test-run",
      stdin: undefined,
    })),
  };
});

beforeAll(() =>
  withEnvAsync(
    {
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(os.tmpdir(), "openclaw-test-no-bundled-extensions"),
    },
    async () => {
      ({ createOpenClawCodingTools } = await import("./agent-tools.js"));
    },
  ),
);

beforeEach(() => supervisorSpawnMock.mockClear());

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return {
    ...mod,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 50),
  };
});

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: supervisorSpawnMock,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));

vi.mock("./channel-tools.js", () => ({
  copyChannelAgentToolMeta: vi.fn((_from, to) => to),
  getChannelAgentToolMeta: () => undefined,
  listChannelAgentTools: () => [],
}));

vi.mock("./openclaw-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-tools.js")>();
  return {
    createOpenClawTools: () => [],
    filterToolsByClientCaps: actual.filterToolsByClientCaps,
  };
});

vi.mock("./bash-tools.exec-host-shared.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-host-shared.js")>();
  return {
    ...mod,
    resolveExecHostApprovalContext: () => ({
      approvals: mockExecApprovals,
      hostSecurity: "allowlist",
      hostAsk: "off",
      askFallback: "deny",
    }),
  };
});

vi.mock("../plugins/tools.js", () => ({
  resolvePluginTools: () => [],
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const approvals = mockExecApprovals;
  return {
    ...mod,
    loadExecApprovalsReadOnlyAsync: async () => approvals.file,
    resolveExecApprovals: () => approvals,
    resolveExecApprovalsLocked: async () => approvals,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(resetProcessRegistryForTests);

describe("createOpenClawCodingTools safeBins", () => {
  it.each([true, false])("requires a custom safe-bin profile (configured=%s)", async (profiled) => {
    if (process.platform === "win32") {
      return;
    }
    const tmpDir = tempDirs.make("openclaw-safe-bins-");
    const exec = {
      host: "gateway" as const,
      mode: "allowlist" as const,
      safeBins: ["echo"],
      ...(profiled ? { safeBinProfiles: { echo: { maxPositional: 1 } } } : {}),
    };
    const execTool = createOpenClawCodingTools({
      config: { tools: { exec } },
      exec: { notifyOnExit: false },
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
      agentDir: path.join(tmpDir, "agent"),
    }).find((tool) => tool.name === "exec");
    if (!execTool) {
      throw new Error("exec tool missing from coding tools");
    }
    await withEnvAsync(
      { OPENCLAW_SHELL_ENV_TIMEOUT_MS: "1", PATH: "/usr/bin:/bin", SHELL: "/bin/sh" },
      async () => {
        const result = execTool.execute("safe-bin", {
          command: "echo safe-bins-marker",
          workdir: tmpDir,
        });
        if (profiled) {
          const completed = await result;
          expect(completed).toMatchObject({ details: { status: "completed" } });
          expect(completed.content.find((block) => block.type === "text")?.text).toContain(
            "safe-bins-marker",
          );
          expect(supervisorSpawnMock).toHaveBeenCalledOnce();
        } else {
          await expect(result).rejects.toThrow("exec denied: allowlist miss");
          expect(supervisorSpawnMock).not.toHaveBeenCalled();
        }
      },
    );
  });
});
