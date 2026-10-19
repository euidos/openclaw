import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { wrapToolWithAbortSignal } from "./agent-tools.abort.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import {
  getActiveAgentRingZeroTools,
  runWithAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import { stubTool } from "./test-helpers/fast-tool-stubs.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

const abortError = { name: "AbortError", message: "Aborted" };
const handoffReason = { code: "sessions_yield", turnHandoff: true } as const;
const emptyResult = () => ({ content: [], details: {} });
let runAbort: AbortController;
beforeEach(() => {
  runAbort = new AbortController();
});

function tool(execute: AnyAgentTool["execute"], name = "tool"): AnyAgentTool {
  return { ...stubTool(name), label: name, execute };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function wrap(source: AnyAgentTool | AnyAgentTool["execute"], name = "tool") {
  return wrapToolWithAbortSignal(
    typeof source === "function" ? tool(source, name) : source,
    runAbort.signal,
  );
}

function yieldTool(onYield = () => runAbort.abort(handoffReason)) {
  return wrapToolWithAbortSignal(
    createSessionsYieldTool({ sessionId: "requester", claimYield: () => true, onYield }),
    runAbort.signal,
  );
}

function prepareWithAbort(
  source: NonNullable<ReturnType<typeof getInternalToolExecutionPreparer>>,
) {
  const adapted = wrap(attachInternalToolExecutionPreparer(tool(vi.fn()), source));
  const prepare = expectDefined(
    getInternalToolExecutionPreparer(adapted),
    "abort-adapted preparer",
  );
  return prepare({ toolCallId: "aborted", args: {} });
}

describe("wrapToolWithAbortSignal", () => {
  it("handles rejection after synchronous abort", async () => {
    const pending = deferred<never>();
    const wrapped = wrap(() => {
      runAbort.abort();
      return pending.promise;
    });
    await expect(wrapped.execute("call", {})).rejects.toMatchObject(abortError);
    // Vitest reports an unhandled late rejection if the losing promise is detached incorrectly.
    pending.reject(new Error("tool observed the abort"));
    await flushMicrotasks();
  });

  it("aborts siblings during yield handoff", async () => {
    const sibling = wrap(() => new Promise<never>(() => {}));
    const aborted = expect(sibling.execute("sibling", {})).rejects.toMatchObject(abortError);
    const result = await yieldTool().execute("yield", {});
    expect(result).toMatchObject({ details: { status: "yielded" } });
    expect(result).not.toHaveProperty("details.message");
    await aborted;
  });

  it.each(["direct", "prepared"] as const)(
    "permits only reloadAndResume handoff (%s)",
    async (mode) => {
      for (const action of ["reloadAndResume", "reload", "list"]) {
        runAbort = new AbortController();
        const result = emptyResult();
        const execute = async () => {
          runAbort.abort(handoffReason);
          return result;
        };
        const source = tool(execute, "plugins");
        if (mode === "prepared") {
          attachInternalToolExecutionPreparer(source, async ({ args }) => ({
            kind: "ready",
            args,
            execute,
            dispose: () => undefined,
          }));
        }
        const wrapped = wrap(source);
        let execution: Promise<unknown>;
        if (mode === "prepared") {
          const prepare = expectDefined(getInternalToolExecutionPreparer(wrapped), "preparer");
          const prepared = await prepare({ toolCallId: "reload", args: { action } });
          if (prepared.kind !== "ready") {
            throw new Error("expected ready tool execution");
          }
          execution = prepared.execute().finally(prepared.dispose);
        } else {
          execution = wrapped.execute("reload", { action });
        }
        if (action === "reloadAndResume") {
          await expect(execution).resolves.toBe(result);
        } else {
          await expect(execution).rejects.toMatchObject(abortError);
        }
      }
    },
  );

  it("preserves handoff with both signals aborted", async () => {
    const callAbort = new AbortController();
    const wrapped = yieldTool(() => {
      runAbort.abort(handoffReason);
      callAbort.abort(handoffReason);
    });
    await expect(wrapped.execute("yield", {}, callAbort.signal)).resolves.toMatchObject({
      details: { status: "yielded" },
    });
    expect(runAbort.signal.reason).toBe(handoffReason);
    expect(callAbort.signal.reason).toBe(handoffReason);
  });

  it("rejects caller-authored handoff", async () => {
    const callAbort = new AbortController();
    const wrapped = wrap(() => new Promise<never>(() => {}), "sessions_yield");
    const execution = wrapped.execute("yield", {}, callAbort.signal);
    callAbort.abort(handoffReason);
    await expect(execution).rejects.toMatchObject(abortError);
    expect(runAbort.signal.aborted).toBe(false);
  });

  it("rejects disabled owner handoff", async () => {
    const wrapped = wrap(async () => {
      runAbort.abort({ code: "sessions_yield", turnHandoff: false });
      return emptyResult();
    }, "sessions_yield");
    await expect(wrapped.execute("yield", {})).rejects.toMatchObject(abortError);
  });

  it("never starts after handoff", async () => {
    runAbort.abort(handoffReason);
    const onYield = vi.fn();
    await expect(yieldTool(onYield).execute("yield", {})).rejects.toMatchObject(abortError);
    expect(onYield).not.toHaveBeenCalled();
  });

  it("preserves yield failure during handoff", async () => {
    const yieldError = new Error("yield bookkeeping failed");
    const wrapped = yieldTool(() => {
      runAbort.abort(handoffReason);
      throw yieldError;
    });
    await expect(wrapped.execute("yield", {})).rejects.toBe(yieldError);
  });

  it.each(["before", "during"])("cancels %s private preparation", async (when) => {
    const started = deferred();
    const blocked = deferred();
    const dispose = vi.fn();
    const body = vi.fn(async () => emptyResult());
    const source = vi.fn(async () => {
      started.resolve();
      await blocked.promise;
      return { kind: "ready" as const, args: {}, execute: body, dispose };
    });
    if (when === "before") {
      runAbort.abort();
    }
    const preparing = prepareWithAbort(source);
    if (when === "during") {
      await started.promise;
      runAbort.abort();
    }
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    if (when === "before") {
      expect(source).not.toHaveBeenCalled();
      return;
    }
    blocked.resolve();
    await flushMicrotasks();
    expect(dispose).toHaveBeenCalledOnce();
    expect(body).not.toHaveBeenCalled();
  });
});

vi.mock("./channel-tools.js", () => ({
  listChannelAgentTools: () => [stubTool("plugin_login")],
  copyChannelAgentToolMeta: <T>(value: T) => value,
  getChannelAgentToolMeta: () => undefined,
}));

it("restricts node-originated runs to the node-safe tool subset", () => {
  const names = createOpenClawCodingTools({ messageProvider: "node" }).map((entry) => entry.name);
  expect(names).toContain("canvas");
  for (const name of ["exec", "read", "write", "edit", "message", "sessions_send", "subagents"]) {
    expect(names, name).not.toContain(name);
  }
});

describe("agent ring-zero tool context", () => {
  it("isolates concurrent runs and clears scope", async () => {
    const firstReady = deferred();
    const secondReady = deferred();
    const release = deferred();
    const run = (name: string, ready: ReturnType<typeof deferred<void>>) =>
      runWithAgentRingZeroTools([tool(async () => emptyResult(), name)], async () => {
        ready.resolve();
        await release.promise;
        return getActiveAgentRingZeroTools();
      });
    const first = run("first", firstReady);
    const second = run("second", secondReady);
    await Promise.all([firstReady.promise, secondReady.promise]);
    expect(getActiveAgentRingZeroTools()).toEqual([]);
    release.resolve();
    expect((await first).map((entry) => entry.name)).toEqual(["first"]);
    expect((await second).map((entry) => entry.name)).toEqual(["second"]);
    expect(getActiveAgentRingZeroTools()).toEqual([]);
  });

  it("clears inherited authority in nested runs", () => {
    runWithAgentRingZeroTools([tool(async () => emptyResult(), "ring-zero")], () => {
      expect(getActiveAgentRingZeroTools().map((entry) => entry.name)).toEqual(["ring-zero"]);
      runWithAgentRingZeroTools([], () => expect(getActiveAgentRingZeroTools()).toEqual([]));
      expect(getActiveAgentRingZeroTools().map((entry) => entry.name)).toEqual(["ring-zero"]);
    });
    expect(getActiveAgentRingZeroTools()).toEqual([]);
  });

  it("revokes detached callbacks after settlement", async () => {
    const release = deferred();
    const detachedResult = deferred<readonly AnyAgentTool[]>();
    await runWithAgentRingZeroTools([tool(async () => emptyResult(), "ring-zero")], async () => {
      expect(getActiveAgentRingZeroTools().map((entry) => entry.name)).toEqual(["ring-zero"]);
      void release.promise.then(() => detachedResult.resolve(getActiveAgentRingZeroTools()));
    });
    expect(getActiveAgentRingZeroTools()).toEqual([]);
    release.resolve();
    expect(await detachedResult.promise).toEqual([]);
  });

  it("revokes retained tools after settlement", async () => {
    const execute = vi.fn(async () => emptyResult());
    let retained: AnyAgentTool | undefined;
    await runWithAgentRingZeroTools([tool(execute, "ring-zero")], async () => {
      retained = getActiveAgentRingZeroTools()[0];
      await retained?.execute("inside", {}, undefined, undefined);
    });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      expectDefined(retained, "retained ring-zero tool").execute("outside", {}),
    ).rejects.toThrow('host-scoped tool "ring-zero" is no longer authorized for this run');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
