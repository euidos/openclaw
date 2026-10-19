/** Gateway durable session-face behavior. */
import path from "node:path";
import { expect, test } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { boardStore } from "./board-store.js";
import { onceMessage, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();
type BoardSession = {
  key: string;
  boardFace?: string;
  boardPresentation?: string;
  hasBoard?: boolean;
};
type BoardList = { sessions: BoardSession[]; totalCount: number };
type Client = Awaited<ReturnType<typeof openClient>>["ws"];

async function request<T>(ws: Client, method: string, params: Record<string, unknown>) {
  const result = await rpcReq<T>(ws, method, params);
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.payload!;
}

async function withClient(scopes: string[], run: (ws: Client) => Promise<void>) {
  const { ws } = await openClient({ scopes });
  try {
    await run(ws);
  } finally {
    ws.close();
  }
}

test("dashboard defaults persist for another client and clear without changing the board face", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard-default";
  await writeSessionStore({
    entries: {
      [key]: { sessionId: "dashboard-default", updatedAt: 1, boardFace: "dashboard" },
    },
  });
  await withClient(["operator.read", "operator.write"], async (ws) => {
    const patched = await request<{ entry: BoardSession }>(ws, "sessions.patch", {
      key,
      boardPresentation: "expanded",
    });
    expect(patched.entry.boardPresentation).toBe("expanded");
    const invalid = await rpcReq(ws, "sessions.patch", {
      key,
      boardPresentation: "fullscreen",
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  // Drop the cached handle before the next client reads the durable session row.
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  await closeOpenClawAgentDatabaseByPathAsync(target.path);
  await withClient(["operator.read"], async (ws) => {
    const described = await request<{ session: BoardSession }>(ws, "sessions.describe", { key });
    expect(described.session.boardPresentation).toBe("expanded");
    const listed = await rpcReq<BoardList>(ws, "sessions.list", {});
    expect(listed.payload?.sessions).toContainEqual(
      expect.objectContaining({ key, boardPresentation: "expanded" }),
    );
    const resolved = await request<BoardSession>(ws, "sessions.resolve", {
      reference: { key },
    });
    expect(resolved.boardPresentation).toBe("expanded");
    const denied = await rpcReq(ws, "sessions.patch", { key, boardPresentation: "split" });
    expect(denied).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("missing scope: operator.write") },
    });
  });

  await withClient(["operator.read", "operator.write"], async (ws) => {
    const cleared = await request<{ entry: BoardSession }>(ws, "sessions.patch", {
      key,
      boardPresentation: null,
    });
    expect(cleared.entry.boardFace).toBe("dashboard");
    expect(cleared.entry.boardPresentation).toBeUndefined();
    await closeOpenClawAgentDatabaseByPathAsync(target.path);
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(entry?.boardFace).toBe("dashboard");
    expect(entry).not.toHaveProperty("boardPresentation");
    const described = await request<{ session: BoardSession }>(ws, "sessions.describe", { key });
    expect(described.session).not.toHaveProperty("boardPresentation");
    const listed = await request<BoardList>(ws, "sessions.list", {});
    expect(listed.sessions.find((session) => session.key === key)).not.toHaveProperty(
      "boardPresentation",
    );
  });
});

test("sessions.list filters dashboard sessions by board existence instead of saved face", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      board: { sessionId: "sess-board", updatedAt: now, boardFace: "chat" },
      faceOnly: { sessionId: "sess-face-only", updatedAt: now - 1, boardFace: "dashboard" },
    },
  });
  await boardStore.applyOps({ sessionKey: "agent:main:board" }, [
    { kind: "tab_create", tabId: "main", title: "Dashboard" },
  ]);

  await withClient(["operator.read", "operator.write"], async (ws) => {
    const listed = await request<BoardList>(ws, "sessions.list", {
      hasBoard: true,
      rowMode: "compact",
      limit: 50,
    });

    expect(listed.totalCount).toBe(1);
    expect(listed.sessions).toEqual([
      expect.objectContaining({ key: "agent:main:board", boardFace: "chat", hasBoard: true }),
    ]);

    const withoutBoards = await request<BoardList>(ws, "sessions.list", {
      hasBoard: false,
      limit: 50,
    });
    expect(withoutBoards.totalCount).toBe(1);
    expect(withoutBoards.sessions).toEqual([
      expect.objectContaining({ key: "agent:main:faceonly", hasBoard: false }),
    ]);

    await request(ws, "sessions.subscribe", {});
    const changed = onceMessage(
      ws,
      (event) =>
        event.type === "event" &&
        event.event === "sessions.changed" &&
        event.payload?.sessionKey === "agent:main:board" &&
        event.payload?.reason === "board",
    );
    await request(ws, "board.update", {
      sessionKey: "agent:main:board",
      ops: [{ kind: "tab_delete", tabId: "main" }],
    });
    expect((await changed).payload?.session).toMatchObject({
      key: "agent:main:board",
      hasBoard: false,
    });
  });
});

test("sessions.list ignores a same-owner sentinel board in an unselected store", async () => {
  const rootStateDir = process.env.OPENCLAW_STATE_DIR;
  if (!rootStateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  const stateDir = path.join(rootStateDir, "board-selected-store-later");
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const firstPath = path.join(stateDir, "a-first.sqlite");
    const laterPath = path.join(stateDir, "z-later.sqlite");
    for (const [storePath, sessionId] of [
      [firstPath, "selected-first"],
      [laterPath, "unselected-later"],
    ] as const) {
      replaceSessionEntrySync(
        { agentId: "main", storePath, sessionKey: "unknown" },
        { sessionId, updatedAt: 1 },
      );
    }
    const boards = new SqliteBoardStore({
      resolveSession: () => ({
        agentId: "main",
        path: laterPath,
        sessionKey: "unknown",
      }),
    });
    await boards.applyOps({ sessionKey: "unknown" }, [
      { kind: "tab_create", tabId: "main", title: "Selected-store dashboard" },
    ]);
    testState.agentsConfig = { entries: { main: {} } };
    testState.sessionConfig = {
      store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
    };
    for (const hasBoard of [true, false]) {
      const result = await directSessionReq<{
        sessions: Array<{ key: string; agentId: string; sessionId: string }>;
      }>("sessions.list", { configuredAgentsOnly: true, includeUnknown: true, hasBoard });
      expect(result.ok).toBe(true);
      expect(
        result.payload?.sessions.map(({ key, agentId, sessionId }) => ({
          key,
          agentId,
          sessionId,
        })),
      ).toEqual(
        !hasBoard ? [{ key: "unknown", agentId: "main", sessionId: "selected-first" }] : [],
      );
    }
  });
});
