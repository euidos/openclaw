import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTelegramQaTransportAdapter: vi.fn(),
  listTelegramQaScenarios: vi.fn(),
  printLiveTransportQaArtifacts: vi.fn(),
  resolveTelegramQaRunOptions: vi.fn(
    (options: {
      allowFailures?: boolean;
      listScenarios?: boolean;
      primaryModel?: string;
      providerMode?: string;
      repoRoot: string;
    }) => ({
      ...options,
      allowFailures: options.allowFailures ?? false,
      listScenarios: false,
    }),
  ),
  resolveTelegramQaScenarioIds: vi.fn(),
  runQaFlowSuiteFromRuntime: vi.fn(),
}));

vi.mock("../../suite-launch.runtime.js", () => ({
  runQaFlowSuiteFromRuntime: mocks.runQaFlowSuiteFromRuntime,
}));

vi.mock("../shared/live-artifacts.js", () => ({
  printLiveTransportQaArtifacts: mocks.printLiveTransportQaArtifacts,
}));

vi.mock("./adapter.runtime.js", () => ({
  createTelegramQaTransportAdapter: mocks.createTelegramQaTransportAdapter,
}));

vi.mock("./run-options.runtime.js", () => ({
  resolveTelegramQaRunOptions: mocks.resolveTelegramQaRunOptions,
}));

vi.mock("./scenario-selection.js", () => ({
  listTelegramQaScenarios: mocks.listTelegramQaScenarios,
  resolveTelegramQaScenarioIds: mocks.resolveTelegramQaScenarioIds,
}));

import { runQaTelegramCommand, runQaTelegramSuite } from "./cli.runtime.js";

const SUT_COMMAND_ENV = "OPENCLAW_QA_TELEGRAM_SUT_OPENCLAW_COMMAND";

describe("Telegram live QA scenario gate", () => {
  let previousExitCode: typeof process.exitCode;
  let tempRoot: string;
  let summaryPath: string;

  function writeSummary(status: string) {
    const skipped = status === "skip" || status === "skipped";
    writeSummaryData({
      run: { status: "completed" },
      counts: {
        total: 1,
        passed: Number(status === "pass"),
        failed: Number(status === "fail"),
        skipped: Number(skipped),
      },
      scenarios: [{ name: "channel-canary", status }],
    });
  }

  function writeSummaryData(summary: unknown) {
    writeFileSync(summaryPath, JSON.stringify(summary), "utf8");
  }

  const runSuite = (allowFailures = false) =>
    runQaTelegramSuite({ repoRoot: "/repo", providerMode: "mock-openai", allowFailures });

  beforeEach(() => {
    previousExitCode = process.exitCode;
    // Bun does not clear a previous failure when assigned undefined.
    process.exitCode = 0;
    vi.clearAllMocks();
    vi.stubEnv(SUT_COMMAND_ENV, undefined);
    tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-qa-telegram-gate-"));
    summaryPath = path.join(tempRoot, "qa-suite-summary.json");
    writeSummary("pass");
    mocks.resolveTelegramQaScenarioIds.mockReturnValue(["channel-canary"]);
    mocks.runQaFlowSuiteFromRuntime.mockResolvedValue({
      reportPath: ".artifacts/qa-e2e/telegram/qa-suite-report.md",
      summaryPath,
    });
  });

  afterEach(() => {
    process.exitCode = previousExitCode ?? 0;
    rmSync(tempRoot, { force: true, recursive: true });
    vi.unstubAllEnvs();
  });

  it.each(["fail", "skip"])("fails the live Telegram lane on %s scenarios", async (status) => {
    writeSummary(status);

    await runSuite();

    expect(process.exitCode).toBe(1);
  });

  it("permits genuinely executed failed scenarios when failures are explicitly allowed", async () => {
    writeSummary("fail");
    await runSuite(true);

    expect(process.exitCode).toBe(0);
  });

  it.each([
    { summary: "missing", expected: "Could not read QA summary" },
    { summary: "malformed", expected: "Could not parse QA summary" },
    { summary: "zero-work", expected: "did not include any executed scenarios" },
    { summary: "required-skip", expected: "did not include any executed scenarios" },
  ])(
    "rejects $summary Telegram summaries even with --allow-failures",
    async ({ summary, expected }) => {
      if (summary === "missing") {
        rmSync(summaryPath);
      } else if (summary === "malformed") {
        writeFileSync(summaryPath, "{not-json", "utf8");
      } else if (summary === "zero-work") {
        writeSummaryData({
          run: { status: "completed" },
          counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
          scenarios: [],
        });
      } else {
        writeSummary("skip");
      }

      await expect(runSuite(true)).rejects.toThrow(expected);
      expect(process.exitCode).toBe(0);
    },
  );

  it("lists only scenarios accepted by its flow runner", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.listTelegramQaScenarios.mockReturnValue([
      {
        id: "channel-message-flows",
        defaultEnabled: true,
        title: "Message flows",
        rationale: "Exercise Telegram message flows",
        regressionRefs: [],
      },
    ]);
    mocks.resolveTelegramQaRunOptions.mockReturnValueOnce({
      allowFailures: false,
      listScenarios: true,
      providerMode: "mock-openai",
      repoRoot: process.cwd(),
    });

    await runQaTelegramSuite({
      listScenarios: true,
      providerMode: "mock-openai",
      repoRoot: process.cwd(),
    });

    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("channel-message-flows\tdefault\t");
    expect(output).not.toContain("telegram-startup-getme-live");
    expect(mocks.runQaFlowSuiteFromRuntime).not.toHaveBeenCalled();
  });

  it("selects scenarios against the exact requested model before suite startup", async () => {
    await runQaTelegramCommand({
      allowFailures: true,
      primaryModel: "openai/custom-selection-model",
      providerMode: "live-frontier",
      repoRoot: process.cwd(),
    });

    expect(mocks.resolveTelegramQaScenarioIds).toHaveBeenCalledWith({
      profile: undefined,
      primaryModel: "openai/custom-selection-model",
      providerMode: "live-frontier",
      scenarioIds: undefined,
    });
    expect(mocks.runQaFlowSuiteFromRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ primaryModel: "openai/custom-selection-model" }),
    );
  });
});
