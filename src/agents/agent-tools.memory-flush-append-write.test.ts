import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createWriteTool } from "./sessions/tools/index.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const RELATIVE_PATH = "memory/2026-08-08.md";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let declaredWriteTool: ReturnType<typeof createWriteTool>;
let declaredWriteOutputSchema: JsonSchemaObject;

describe("wrapToolMemoryFlushAppendOnlyWrite output contract", () => {
  let root: string;
  let baseTool: AnyAgentTool;
  const absolute = () => path.join(root, RELATIVE_PATH);
  async function seed(content: string) {
    await fs.mkdir(path.dirname(absolute()), { recursive: true });
    await fs.writeFile(absolute(), content);
  }
  function wrap(options: Partial<Parameters<typeof wrapToolMemoryFlushAppendOnlyWrite>[1]> = {}) {
    return wrapToolMemoryFlushAppendOnlyWrite(baseTool, {
      root,
      relativePath: RELATIVE_PATH,
      ...options,
    });
  }

  beforeEach(() => {
    root = tempDirs.make("memory-flush-write-");
    // Mirror the catalog path: declared schemas are JSON-serialized before the
    // bridge validates results against them. Read the schema from the public
    // tool factory so production internals do not need a test-only export.
    declaredWriteTool = createWriteTool(root);
    const outputSchema = declaredWriteTool.outputSchema;
    if (!isRecord(outputSchema)) {
      throw new Error("The public write tool must declare an object output schema");
    }
    declaredWriteOutputSchema = structuredClone(outputSchema);
    baseTool = {
      ...declaredWriteTool,
      outputSchema: declaredWriteOutputSchema,
      execute: vi.fn(async () => {
        throw new Error("append-only wrapper should not delegate for append params");
      }),
    };
  });

  describe.each(["host", "sandbox"] as const)("%s append", (backend) => {
    const saved =
      "# Daily notes\n\n- Project Alder uses port 7319.\n\n## Deployment\nUse staging first.\n\n---\n";
    const added = "- Project Birch uses port 8421.\n";
    const backendTool = () =>
      wrap({
        sandbox:
          backend === "sandbox" ? { root, bridge: createHostSandboxFsBridge(root) } : undefined,
      });

    it.each([
      ["whole note", saved, saved + added],
      ["whole note without trailing newline", saved.trimEnd(), saved + added],
      ["interior read window", saved, "## Deployment\nUse staging first.\n\n" + added],
      ["copied fact", saved, "- Project Alder uses port 7319.\n\n" + added],
      [
        "copied prefix without a blank separator",
        saved,
        "- Project Alder uses port 7319.\n" + added,
      ],
      ["Windows note", saved.replaceAll("\n", "\r\n"), saved + added],
      ["retry of saved note", saved, saved],
    ])(
      "rejects %s without mutation and accepts a new-content retry",
      async (_name, existing, content) => {
        await seed(existing);
        const tool = backendTool();
        await expect(tool.execute("replay", { path: RELATIVE_PATH, content })).rejects.toThrow(
          "Retry with only new content",
        );
        expect(await fs.readFile(absolute(), "utf8")).toBe(existing);
        await tool.execute("delta", { path: RELATIVE_PATH, content: added });
        expect(await fs.readFile(absolute(), "utf8")).toBe(
          existing + (existing.endsWith("\n") ? "" : "\n") + added,
        );
      },
    );

    it("creates a note and permits repeated headings with new facts", async () => {
      const tool = backendTool();
      await tool.execute("create", { path: RELATIVE_PATH, content: saved });
      const content = "# Daily notes\n\n---\n\n## Deployment\nUse port 8421 for Birch.\n";
      await tool.execute("new-facts", { path: RELATIVE_PATH, content });
      expect(await fs.readFile(absolute(), "utf8")).toBe(saved + content);
    });
  });

  it("rechecks source authority after provenance work before appending", async () => {
    await seed("seed\n");
    const originalClaim = {};
    let claim = originalClaim;
    let reachedCommit = false;
    const wrapped = wrap({
      memoryWriteProvenance: {
        classifies: async () => true,
        write: async ({ commit }) => {
          reachedCommit = true;
          claim = {};
          await commit();
        },
        clearAfterDelete: async () => {},
      },
    });
    const pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:memory-flush-authority",
        receiptAuthority: () => claim === originalClaim,
      },
      () => wrapped.execute("source-append", { path: RELATIVE_PATH, content: "hello" }),
    );
    await expect(pending).rejects.toThrow("authority is no longer active");
    expect(reachedCommit).toBe(true);
    expect(await fs.readFile(absolute(), "utf8")).toBe("seed\n");
  });

  it("appends schema-conforming results only to the allowed memory file", async () => {
    await seed("seed");
    const wrapped = wrap();
    const result = await wrapped.execute("call-append", {
      path: RELATIVE_PATH,
      content: "hello",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: `Appended content to ${RELATIVE_PATH}.` }],
      details: { changed: true },
    });
    expect(
      validateJsonSchemaValue({
        schema: declaredWriteOutputSchema,
        cacheKey: "test:memory-flush-write-output",
        value: result.details,
        cache: false,
      }).ok,
    ).toBe(true);
    expect(await fs.readFile(absolute(), "utf-8")).toBe("seed\nhello");
    await expect(
      wrapped.execute("call-sibling", {
        path: "memory/other-day.md",
        content: "wrong target",
      }),
    ).rejects.toThrow(
      `Memory flush writes are restricted to ${RELATIVE_PATH}; use that path only.`,
    );
    expect(baseTool.execute).not.toHaveBeenCalled();
  });

  it.each(["file", "absent"] as const)(
    "rejects @memory paths instead of appending to their allowed sibling (literal: %s)",
    async (literalState) => {
      const literalPath = path.join(root, `@${RELATIVE_PATH}`);
      await seed("allowed");
      if (literalState === "file") {
        await fs.mkdir(path.dirname(literalPath), { recursive: true });
        await fs.writeFile(literalPath, "literal", "utf8");
      }
      const wrapped = wrap();

      await expect(
        wrapped.execute("at-memory-flush", {
          path: `@${RELATIVE_PATH}`,
          content: "wrong journal",
        }),
      ).rejects.toThrow(/Memory flush writes are restricted/);
      await expect(fs.readFile(absolute(), "utf8")).resolves.toBe("allowed");
      if (literalState === "file") {
        await expect(fs.readFile(literalPath, "utf8")).resolves.toBe("literal");
      }
    },
  );
});
