import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.js";
import { buildSubagentRunView } from "../../agents/subagents/registry/subagent-run-view.js";
import { resolveSubagentEntryForToken } from "./commands-subagents/shared.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

const NOW_MS = 1_700_000_000_000;

type RunOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
  execution?: SubagentRunRecord["execution"];
};

function makeRun(overrides: RunOverrides): SubagentRunRecord {
  const { startedAt, endedAt, outcome, execution, ...recordOverrides } = overrides;
  return {
    runId: "run-default",
    childSessionKey: `agent:main:subagent:${overrides.runId ?? "run-default"}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "default task",
    cleanup: "keep",
    createdAt: NOW_MS - 2_000,
    ...recordOverrides,
    execution:
      execution ??
      (endedAt === undefined
        ? { status: "running", startedAt }
        : { status: "terminal", startedAt, endedAt, outcome }),
  };
}

function runView(runs: SubagentRunRecord[]) {
  return buildSubagentRunView({ runs, countPendingDescendantRuns: () => 0, recentMinutes: 30 });
}

function expectTarget(runs: SubagentRunRecord[], token: string | undefined, expected: string) {
  const result = resolveSubagentEntryForToken(runView(runs), token);
  expect("entry" in result ? result.entry.runId : result.reply.reply?.text).toBe(expected);
}

describe("subagents utils", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  });
  afterEach(() => vi.restoreAllMocks());

  it("resolves subagent label with fallback", () => {
    expect(resolveSubagentLabel(makeRun({ label: "  runner " }))).toBe("runner");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: "  task value " }))).toBe("task value");
    expect(resolveSubagentLabel(makeRun({ label: " ", task: " " }), "fallback")).toBe("fallback");
  });

  it("sorts by startedAt then createdAt descending", () => {
    const view = runView([
      makeRun({ runId: "a", createdAt: 10 }),
      makeRun({ runId: "b", startedAt: 15, createdAt: 5 }),
      makeRun({ runId: "c", startedAt: 12, createdAt: 20 }),
    ]);
    expect(view.latest.map((entry) => entry.runId)).toEqual(["b", "c", "a"]);
  });

  it("selects last from sorted runs", () => {
    const runs = [
      makeRun({ runId: "old", createdAt: NOW_MS - 2_000 }),
      makeRun({ runId: "new", createdAt: NOW_MS - 500 }),
    ];
    expectTarget(runs, " last ", "new");
  });

  it("resolves numeric index from running then recent finished order", () => {
    const runs = [
      makeRun({ runId: "running", label: "running", createdAt: NOW_MS - 8_000 }),
      makeRun({
        runId: "recent-finished",
        label: "recent",
        createdAt: NOW_MS - 6_000,
        endedAt: NOW_MS - 60_000,
      }),
      makeRun({
        runId: "old-finished",
        label: "old",
        createdAt: NOW_MS - 7_000,
        endedAt: NOW_MS - 2 * 60 * 60 * 1_000,
      }),
    ];

    expectTarget(runs, "1", "running");
    expectTarget(runs, "2", "recent-finished");
    expectTarget(runs, "3", "⚠️ Invalid subagent index: 3");
  });

  it("resolves session key target and unknown session errors", () => {
    const run = makeRun({ runId: "abc123", childSessionKey: "agent:beta:subagent:xyz" });
    expectTarget([run], "agent:beta:subagent:xyz", "abc123");
    expectTarget(
      [run],
      "agent:beta:subagent:missing",
      "⚠️ Unknown subagent session: agent:beta:subagent:missing",
    );
  });

  it("resolves exact label, prefix, run-id prefix and ambiguity errors", () => {
    const runs = [
      makeRun({ runId: "run-alpha-1", label: "Alpha Core" }),
      makeRun({ runId: "run-alpha-2", label: "Alpha Orbit" }),
      makeRun({ runId: "run-beta-1", label: "Beta Worker" }),
    ];

    expectTarget(runs, "beta worker", "run-beta-1");
    expectTarget(runs, "beta", "run-beta-1");
    expectTarget(runs, "run-beta", "run-beta-1");

    expectTarget(runs, "alpha core", "run-alpha-1");
    expectTarget(runs, "alpha", "⚠️ Ambiguous subagent label prefix: alpha");
    expectTarget(runs, "run-alpha", "⚠️ Ambiguous run id prefix: run-alpha");
    expectTarget(runs, "missing", "⚠️ Unknown subagent id: missing");
    expectTarget(runs, undefined, "⚠️ Missing subagent id.");
  });

  it("returns ambiguous exact label error before prefix/run id matching", () => {
    const runs = [
      makeRun({ runId: "run-a", label: "dup" }),
      makeRun({ runId: "run-b", label: "dup" }),
    ];
    expect(resolveTarget(runs, "dup").error).toBe("⚠️ Ambiguous subagent label: dup");
  });

  it("resolves stable taskName aliases before labels and run ids", () => {
    const runs = [
      makeRun({ runId: "run-review-1", label: "Review", taskName: "code_review" }),
      makeRun({ runId: "run-review-2", label: "Review copy", taskName: "copy_review" }),
    ];

    expectResolvedRunId(runs, "code_review", "run-review-1");
    expectResolvedRunId(runs, "copy_", "run-review-2");
  });

  it("preserves exact label targets before taskName prefix aliases", () => {
    const runs = [
      makeRun({ runId: "run-review-label", label: "review" }),
      makeRun({ runId: "run-review-docs", label: "docs", taskName: "review_docs" }),
    ];

    expectResolvedRunId(runs, "review", "run-review-label");
    expectResolvedRunId(runs, "review_", "run-review-docs");
  });

  it("ignores stale duplicate taskName aliases when a current run reuses the handle", () => {
    const runs = [
      makeRun({
        runId: "old-review",
        label: "Old review",
        taskName: "review_subagents",
        createdAt: NOW_MS - 2 * 60 * 60 * 1_000,
        endedAt: NOW_MS - 90 * 60 * 1_000,
      }),
      makeRun({
        runId: "current-review",
        label: "Current review",
        taskName: "review_subagents",
        createdAt: NOW_MS - 1_000,
      }),
    ];

    expectTarget(runs, "review_subagents", "current-review");
  });

  it("prefers the current live row when stale and current runs share a label on one child session", () => {
    const runs = [
      makeRun({
        runId: "run-old",
        childSessionKey: "agent:main:subagent:worker",
        label: "same worker",
        createdAt: NOW_MS - 10_000,
        startedAt: NOW_MS - 10_000,
        endedAt: NOW_MS - 5_000,
      }),
      makeRun({
        runId: "run-new",
        childSessionKey: "agent:main:subagent:worker",
        label: "same worker",
        createdAt: NOW_MS - 1_000,
        startedAt: NOW_MS - 1_000,
      }),
    ];

    expectTarget(runs, "same worker", "run-new");
  });
});
