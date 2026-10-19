import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { resolveGatewayLogPaths } from "../../daemon/restart-logs.js";
import { buildWorkspaceSkillReadiness } from "../../skills/discovery/status.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { createStatusCommandOverviewRowsParams } from "../status.test-support.ts";

type GatewayLogPaths = ReturnType<typeof resolveGatewayLogPaths>;

const restartLogMocks = vi.hoisted(() => ({
  resolveGatewayLogPaths: vi.fn<() => GatewayLogPaths>(() => {
    throw new Error("skip log tail");
  }),
  resolveGatewaySupervisorLogPaths: vi.fn<() => GatewayLogPaths>(() => {
    throw new Error("skip log tail");
  }),
  resolveGatewayRestartLogPath: vi.fn<() => string>(() => "/tmp/gateway-restart.log"),
}));

const gatewayMocks = vi.hoisted(() => ({
  readFileTailLines: vi.fn<(filePath: string, maxLines: number) => Promise<string[]>>(
    async () => [],
  ),
  summarizeLogTail: vi.fn<(lines: string[], opts?: { maxLines?: number }) => string[]>(
    (lines) => lines,
  ),
}));

vi.mock("../../daemon/restart-logs.js", () => restartLogMocks);
vi.mock("./gateway.js", () => gatewayMocks);

import { appendStatusAllDiagnosis, readStatusAllLogTails } from "./diagnosis.js";

type DiagnosisParams = Parameters<typeof appendStatusAllDiagnosis>[0];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function availableDiagnostics(value: unknown) {
  return { ok: true as const, value };
}

function createBaseParams(
  listeners: NonNullable<DiagnosisParams["portUsage"]>["listeners"] = [],
): DiagnosisParams {
  return {
    logTails: null,
    lines: [] as string[],
    progress: { setLabel() {}, setPercent() {}, tick() {}, done() {} },
    muted: (text: string) => text,
    ok: (text: string) => text,
    warn: (text: string) => text,
    fail: (text: string) => text,
    connectionDetailsForReport: "ws://127.0.0.1:18789",
    snap: null,
    remoteUrlMissing: false,
    secretDiagnostics: [],
    sentinel: null,
    lastErr: null,
    port: 18789,
    portUsage: { port: 18789, status: "busy", listeners, hints: [] },
    tailscaleMode: "off",
    tailscaleDns: null,
    tailscaleHttpsUrl: null,
    skillReadiness: null,
    pluginCompatibility: [],
    channelsStatus: null,
    channelIssues: [],
    deliveryDiagnostics: null,
    exporterDiagnostics: null,
    gatewayReachable: false,
    health: null,
    nodeOnlyGateway: null,
  };
}

function diagnose(overrides: Partial<DiagnosisParams> = {}) {
  const params = { ...createBaseParams(), ...overrides };
  appendStatusAllDiagnosis(params);
  return params.lines.join("\n");
}

function delivery(
  [received, started, completed, turns, processed]: [number, number, number, number, number],
  type: string,
  ageMs: number,
) {
  const params = createBaseParams();
  params.gatewayReachable = true;
  params.deliveryDiagnostics = availableDiagnostics({
    summary: {
      byType: {
        "message.received": received,
        "message.dispatch.started": started,
        "message.dispatch.completed": completed,
        "session.turn.created": turns,
        "message.processed": processed,
      },
    },
    events: [{ type, ts: Date.now() - ageMs }],
  });
  return params;
}

describe("status-all diagnosis port checks", () => {
  beforeEach(() => {
    for (const mock of Object.values({ ...restartLogMocks, ...gatewayMocks })) {
      mock.mockReset();
    }
  });

  it("keeps first config issue locations and exact pairs before applying the display cap", () => {
    const params = createBaseParams();
    const first = { path: "a", message: "b:c", sourceFile: "legacy.json", line: 7 };
    const repeated = { ...first, sourceFile: "current.json", line: 9 };
    params.snap = {
      exists: true,
      valid: false,
      path: "config.json",
      legacyIssues: [first, { path: "a:b", message: "c" }, first],
      issues: [
        repeated,
        { path: "a", message: "different" },
        ...Array.from({ length: 11 }, (_, index) => ({
          path: `field${index}`,
          message: "invalid",
        })),
        repeated,
      ],
    };
    const original = structuredClone(params.snap);

    appendStatusAllDiagnosis(params);

    const start = params.lines.indexOf("! Config: config.json");
    const end = params.lines.indexOf("✓ Secret diagnostics (0)");
    expect(params.lines.slice(start, end)).toEqual([
      "! Config: config.json",
      "  - legacy.json:7 — a: b:c",
      "  - a:b: c",
      "  - a: different",
      ...Array.from({ length: 9 }, (_, i) => `  - field${i}: invalid`),
      "  … +2 more",
    ]);
    expect(params.snap).toEqual(original);
  });

  it.each([
    { state: "ready", eligible: 1, missing: 0 },
    { state: "missing", eligible: 0, missing: 1 },
    { state: "disabled", eligible: 0, missing: 0 },
  ] as const)("reports skill readiness for $state", ({ state, eligible, missing }) => {
    const workspaceDir = tempDirs.make("openclaw-status-skills-");
    const baseDir = path.join(workspaceDir, "skills", "fixture");
    const params = createBaseParams();
    params.skillReadiness = buildWorkspaceSkillReadiness(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, "managed"),
      agentId: "qa",
      config: {
        plugins: { enabled: false },
        agents: { entries: { qa: { skills: ["fixture"] } } },
        skills: {
          allowBundled: ["other-fixture"],
          entries: { fixture: { enabled: state !== "disabled" } },
        },
      },
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: "fixture",
            description: "Synthetic status readiness fixture",
            filePath: path.join(baseDir, "SKILL.md"),
            baseDir,
            source: "openclaw-workspace",
          }),
          frontmatter: {},
          metadata: {
            requires: {
              bins: state === "ready" ? [] : ["openclaw-qa-readiness-absent-binary"],
            },
          },
        },
      ],
    });

    appendStatusAllDiagnosis(params);

    expect(params.lines.find((line) => line.includes("Skills:"))).toBe(
      `${missing > 0 ? "!" : "✓"} Skills: ${eligible} eligible · ${missing} missing · ${workspaceDir}`,
    );
  });

  it("retains queue warnings from a successful gateway health snapshot", () => {
    const params = createBaseParams();
    params.health = {
      ...createStatusCommandOverviewRowsParams().health!,
      deliveryQueues: {
        failed: [{ queueName: "outbound", count: 2 }],
        ingressPressure: [
          {
            channelId: "telegram",
            accountId: "ops",
            laneCount: 1,
            pendingCount: 2,
            claimedCount: 0,
            blockedCount: 1,
            oldestReceivedAt: Date.now(),
          },
        ],
      },
    };

    const output = diagnose(params);
    expect(output).toContain("Delivery queue: warning");
    expect(output).toContain("outbound: 2");
    expect(output).toContain(
      "inbound telegram/ops: 1 pressured lane, 2 pending, 0 claimed, 1 blocked",
    );
  });

  it("keeps a failed health request visible in the complete report", () => {
    const output = diagnose({ health: { error: "health request timed out" } });
    expect(output).toContain("Gateway health:\n  health request timed out");
    expect(output).toContain("Pasteable debug report. Auth tokens redacted.");
  });

  it("keeps DNS context while daemon state remains unobserved", () => {
    const output = diagnose({ tailscaleDns: "box.tail.ts.net" });
    expect(output).toContain("✓ Tailscale exposure: off · daemon unknown · box.tail.ts.net");
    expect(output).not.toContain("Tailscale: off");
  });

  it("does not warn about an unavailable Tailscale daemon when exposure is disabled", () => {
    expect(diagnose()).toContain("✓ Tailscale exposure: off · daemon unknown");
  });

  it.each([
    [["127.0.0.1:18789", "[::1]:18789"], "Detected dual-stack loopback listeners"],
    [["0.0.0.0:18789"], "Detected OpenClaw Gateway listener on the configured port."],
  ] as const)("treats same-process %j listeners as healthy", (addresses, detail) => {
    const params = createBaseParams(
      addresses.map((address) => ({
        pid: 5001,
        commandLine: "openclaw-gateway",
        address,
      })),
    );
    const output = diagnose(params);
    expect(output).toContain("✓ Port 18789");
    expect(output).toContain(detail);
    expect(output).not.toContain("Port 18789 is already in use.");
  });

  it("keeps warning for multi-process listener conflicts", () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
      { pid: 5002, commandLine: "openclaw-gateway", address: "[::1]:18789" },
    ]);

    const output = diagnose(params);
    expect(output).toContain("! Port 18789");
    expect(output).toContain("2 OpenClaw gateway processes appear to be listening on port 18789");
    expect(output).toContain("Port 18789 is already in use.");
  });

  it("does not let attributed listeners override indeterminate availability", () => {
    const params = createBaseParams([
      { pid: 5001, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
    ]);
    params.portUsage!.status = "unknown";

    const output = diagnose(params);
    expect(output).toContain("! Port 18789");
    expect(output).toContain("Port 18789 availability could not be determined.");
    expect(output).not.toContain("Detected OpenClaw Gateway listener");
  });

  it.each([
    {
      status: "error",
      reason: "managed-service-handoff-failed",
      headline: "⚠️ OpenClaw update failed: managed-service-handoff-failed.",
      hint: "Run openclaw triage to diagnose and repair the failed update.",
    },
    {
      status: "skipped",
      reason: "restart-health-pending",
      headline: "⬆️ OpenClaw update in progress: restarting.",
      hint: "Check progress with openclaw update status.",
    },
  ] as const)(
    "includes the shared update report for $status sentinels",
    ({ status, reason, headline, hint }) => {
      const params = createBaseParams();
      params.sentinel = {
        payload: {
          kind: "update",
          status,
          ts: Date.now() - 60_000,
          stats: { mode: "npm", reason, steps: [] },
        },
      };
      const output = diagnose(params);
      expect(output).toContain(`Update restart: ${headline}`);
      expect(output).toContain(hint);
      expect(output).not.toContain("run openclaw gateway restart");
    },
  );

  it.each([
    [31, null, 0, "!"],
    [5, 45, 1, "✓"],
  ] as const)("reports agent activity for ages %s/%s minutes", (main, worker, active, icon) => {
    const output = diagnose({
      agentStatus: {
        totalSessions: 2,
        agents: [
          { id: "main", lastActiveAgeMs: main * 60_000 },
          { id: "worker", lastActiveAgeMs: worker === null ? null : worker * 60_000 },
        ],
      },
    });
    expect(output).toContain(`${icon} Agent activity: ${active} active in 30m · 2 sessions`);
    const hint = "verify inbound dispatch and turn creation";
    expect(output).toEqual(
      active ? expect.not.stringContaining(hint) : expect.stringContaining(hint),
    );
  });

  it("summarizes inbound delivery telemetry proof counters", () => {
    const output = diagnose(delivery([2, 2, 2, 2, 2], "session.turn.created", 60_000));
    expect(output).toContain(
      "✓ Inbound delivery telemetry: received 2 · dispatch 2/2 · turns 2 · processed 2",
    );
    expect(output).toContain("latest delivery event:");
  });

  it("renders the shared redacted telemetry exporter summary", () => {
    const params = createBaseParams();
    params.exporterDiagnostics = availableDiagnostics({
      events: [
        {
          seq: 1,
          type: "telemetry.exporter",
          source: "diagnostics-otel",
          target: "traces",
          transport: "otlp-http-protobuf",
          outcome: "failure",
          reason: "export_failed",
          mode: "configured",
          url: "https://collector.example/private",
          headers: { authorization: "secret" },
          error: "raw failure",
        },
      ],
    });

    const output = diagnose(params);
    expect(output).toContain("! Telemetry exporters");
    expect(output).toContain(
      "diagnostics-otel · traces · failed · OTLP/HTTP protobuf (explicit endpoint) · export failed",
    );
    expect(output).not.toMatch(/collector\.example|secret|raw failure/);
  });

  it("renders failed diagnostics as unavailable instead of empty", () => {
    const params = createBaseParams();
    params.gatewayReachable = true;
    const failedProbe = {
      ok: false as const,
      error:
        "Error: diagnostics probe timed out at wss://probe-user:probe-pass@gateway.example/socket?token=probe-secret",
    };
    params.deliveryDiagnostics = failedProbe;
    params.exporterDiagnostics = failedProbe;

    const output = diagnose(params);
    expect(output).toContain("! Telemetry exporters: unavailable");
    expect(output).toContain(
      "Exporter diagnostics failed: Error: diagnostics probe timed out at wss://***:***@gateway.example/socket?token=***",
    );
    expect(output).toContain("Retry: openclaw gateway stability --type telemetry.exporter");
    expect(output).toContain("! Inbound delivery telemetry: unavailable");
    expect(output).toContain(
      "Delivery diagnostics failed: Error: diagnostics probe timed out at wss://***:***@gateway.example/socket?token=***",
    );
    expect(output).toContain("Retry: openclaw gateway stability");
    expect(output).not.toContain("received 0 · dispatch 0/0 · turns 0 · processed 0");
    expect(output).not.toMatch(/probe-user|probe-pass|probe-secret/);
  });

  it.each([
    [0, "Messages were received, but no gateway dispatch started"],
    [1, "Gateway dispatch started, but no agent turn was created"],
  ] as const)(
    "keeps handled terminal delivery healthy with %s dispatches",
    (dispatches, warning) => {
      const output = diagnose(
        delivery([1, dispatches, dispatches, 0, 1], "message.processed", 30_000),
      );
      expect(output).toContain(
        `✓ Inbound delivery telemetry: received 1 · dispatch ${dispatches}/${dispatches} · turns 0 · processed 1`,
      );
      expect(output).not.toContain(warning);
    },
  );

  it("warns when received messages never reach agent turn creation", () => {
    const output = diagnose(delivery([3, 3, 1, 0, 1], "message.dispatch.started", 120_000));
    expect(output).toContain(
      "! Inbound delivery telemetry: received 3 · dispatch 3/1 · turns 0 · processed 1",
    );
    expect(output).toContain("Gateway dispatch started, but no agent turn was created");
    expect(output).toContain("Multiple gateway dispatches have not completed yet");
  });

  it("avoids unreachable gateway diagnosis in node-only mode", () => {
    const params = createBaseParams();
    params.connectionDetailsForReport = "Node-only mode detected";
    params.health = undefined;
    params.nodeOnlyGateway = {
      gatewayTarget: "gateway.example.com:19000",
      gatewayValue: "",
      connectionDetails: "",
    };
    params.gatewayReachable = true;
    const failedProbe = {
      ok: false as const,
      error: "Error: diagnostics probe unavailable in node-only mode",
    };
    params.deliveryDiagnostics = failedProbe;
    params.exporterDiagnostics = failedProbe;

    const output = diagnose(params);
    expect(output).toContain("Node-only mode detected");
    expect(output).toContain(
      "Channel issues skipped (node-only mode; query gateway.example.com:19000)",
    );
    expect(output).not.toContain("Channel issues skipped (gateway unreachable)");
    expect(output).not.toContain("Gateway health:");
    expect(output).not.toContain("Inbound delivery telemetry: unavailable");
    expect(output).not.toContain("Telemetry exporters: unavailable");
    expect(output).not.toContain("Retry: openclaw gateway stability");
  });

  it("preserves startup phase in channel diagnosis", () => {
    const output = diagnose({ gatewayStartupPhase: "plugins" });
    expect(output).toContain("Channel issues skipped (gateway still starting (phase plugins))");
    expect(output).not.toContain("gateway unreachable");
    expect(output).not.toContain("Gateway health:");
  });

  it("does not read or display stale stderr tails on Darwin", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const logDir = "/Users/test/Library/Logs/openclaw";
      const stdoutPath = path.join(logDir, "gateway.log"),
        stderrPath = path.join(logDir, "gateway.err.log");
      restartLogMocks.resolveGatewaySupervisorLogPaths.mockReturnValue({
        logDir,
        stdoutPath,
        stderrPath,
      });
      restartLogMocks.resolveGatewayRestartLogPath.mockReturnValue(
        "/tmp/openclaw/logs/gateway-restart.log",
      );
      const tails = {
        [stdoutPath]: ["gateway stdout current"],
        [stderrPath]: ["failed to bind gateway socket stale"],
      };
      gatewayMocks.readFileTailLines.mockImplementation(async (filePath) => tails[filePath] ?? []);
      const output = diagnose({ logTails: await readStatusAllLogTails() });
      expect(gatewayMocks.readFileTailLines).not.toHaveBeenCalledWith(stderrPath, 40);
      expect(output).toContain(`# stdout: ${stdoutPath}`);
      expect(output).toContain("gateway stdout current");
      expect(output).not.toContain("# stderr:");
      expect(output).not.toContain("failed to bind gateway socket stale");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});
