import { once } from "node:events";
import * as http from "node:http";
import { text as readBody } from "node:stream/consumers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tlonPlugin } from "./channel.js";

const TEXT_LIMIT = 10_000;
const textSender = expectDefined(tlonPlugin.message?.send?.text, "preferred Tlon text sender");
const targets = [
  { name: "DM", to: "~nec", threadId: undefined },
  { name: "group", to: "chat/~nec/general", threadId: undefined },
  { name: "thread", to: "chat/~nec/general", threadId: "1700000000000" },
];

function finishLogin(response: http.ServerResponse) {
  response.writeHead(200, { "set-cookie": "urbauth-~zod=mock-cookie" });
  response.end("ok");
}

type Memo = { memo?: { content?: Array<{ inline?: unknown[] }> } };
type TlonPoke = { json?: { diff?: { delta?: { add?: Memo } } } };

const storyText = (poke: TlonPoke) =>
  (poke.json?.diff?.delta?.add?.memo?.content ?? [])
    .flatMap((verse) => verse.inline ?? [])
    .filter((item) => typeof item === "string")
    .join("");

describe("tlon outbound loopback", () => {
  let server: http.Server | undefined;

  async function listenLoopback(handler: http.RequestListener, strictLogin = false) {
    let login = finishLogin;
    server = http.createServer((req, res) => {
      if (req.url === "/~/login" && (!strictLogin || req.method === "POST")) {
        login(res);
      } else {
        handler(req, res);
      }
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const tlon = {
      ship: "~zod",
      url: `http://127.0.0.1:${address.port}`,
      code: "mock-code",
      network: { dangerouslyAllowPrivateNetwork: true },
    };
    const cfg = { channels: { tlon } };
    const controller = new AbortController();
    const dispatch = vi.fn(async () => {});
    type Send = Parameters<NonNullable<typeof textSender>>[0];
    return {
      cfg,
      controller,
      dispatch,
      setLogin: (loginHandler: typeof finishLogin) => {
        login = loginHandler;
      },
      send: (params: Pick<Send, "text"> & Partial<Pick<Send, "to" | "threadId">>) =>
        textSender({
          cfg,
          to: "~nec",
          assertDirectAdapterHandoff: () => controller.signal.throwIfAborted(),
          onPlatformSendDispatch: dispatch,
          ...params,
        }),
    };
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
        server?.closeAllConnections?.();
      });
      server = undefined;
    }
  });

  it.each(["login", "redirect", "dispatch refresh"] as const)(
    "stops requests when authority closes during %s",
    async (phase) => {
      const paused = createDeferred<http.ServerResponse | undefined>();
      const resume = createDeferred<void>();
      const laterRequests: string[] = [];
      const fixture = await listenLoopback((req, res) => {
        laterRequests.push(req.url ?? "");
        res.writeHead(204);
        res.end();
      });
      if (phase !== "dispatch refresh") {
        fixture.setLogin((res) => {
          paused.resolve(res);
        });
      }
      fixture.dispatch.mockImplementation(async () => {
        if (phase === "dispatch refresh") {
          paused.resolve(undefined);
          await resume.promise;
        }
      });
      const revoked = new Error(`authority closed during ${phase}`);
      const result = fixture.send({ text: "cancelled message" }).catch((error: unknown) => error);
      const response = await paused.promise;
      fixture.controller.abort(revoked);
      if (response) {
        if (phase === "redirect") {
          response.writeHead(302, { location: "/~/redirected-login" });
          response.end();
        } else {
          finishLogin(response);
        }
      }
      resume.resolve();

      expect(await result).toBe(revoked);
      expect(laterRequests).toEqual([]);
      expect(fixture.dispatch).toHaveBeenCalledTimes(phase === "dispatch refresh" ? 1 : 0);
    },
  );

  it.each(targets)(
    "retains an accepted $name result after authority closes",
    async ({ name, to, threadId }) => {
      const accepted = createDeferred<{ response: http.ServerResponse; payload: unknown }>();
      const fixture = await listenLoopback(async (req, res) => {
        accepted.resolve({ response: res, payload: JSON.parse(await readBody(req)) });
      });
      const result = fixture.send({ to, threadId, text: "accepted message" });
      const { response, payload } = await accepted.promise;
      expect(fixture.dispatch).toHaveBeenCalledTimes(1);
      const memo = { content: [{ inline: ["accepted message"] }], author: "~zod" };
      const post = threadId
        ? { reply: { id: "1.700.000.000.000", action: { add: memo } } }
        : { add: memo };
      const direct = name === "DM";
      const json = direct
        ? { ship: "~nec", diff: { delta: { add: { memo } } } }
        : { channel: { nest: "chat/~nec/general", action: { post } } };
      expect(payload).toMatchObject([
        {
          app: direct ? "chat" : "channels",
          mark: direct ? "chat-dm-action" : "channel-action-1",
          json,
        },
      ]);
      fixture.controller.abort(new Error("authority closed after poke acceptance"));
      response.writeHead(204);
      response.end();

      const sent = await result;
      expect(sent.receipt).toMatchObject({
        parts: [{ kind: "text" }],
        platformMessageIds: [sent.messageId],
      });
    },
  );

  it("delivers each chunked unit as a bounded independent poke the urbit transport accepts", async () => {
    const pokes: TlonPoke[] = [];
    let rejectedOversized = 0;
    let loginCount = 0;
    const fixture = await listenLoopback(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "PUT" && url.pathname.startsWith("/~/channel/")) {
        const received = JSON.parse(await readBody(req)) as TlonPoke[];
        pokes.push(...received);
        const oversized = received.some((poke) => storyText(poke).length > TEXT_LIMIT);
        rejectedOversized += Number(oversized);
        res.writeHead(oversized ? 413 : 200, { "Content-Type": "text/plain" });
        res.end(oversized ? "memo too long" : "ok");
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }, true);
    fixture.setLogin((res) => {
      loginCount += 1;
      res.setHeader("Content-Type", "text/plain");
      finishLogin(res);
    });

    const outbound = expectDefined(tlonPlugin.outbound, "Tlon outbound adapter");
    const chunker = expectDefined(outbound.chunker, "Tlon chunker");
    expect(outbound.textChunkLimit).toBe(TEXT_LIMIT);

    const text = "x".repeat(10_001);
    const chunks = chunker(text, TEXT_LIMIT);
    for (const chunk of chunks) {
      await outbound.sendText?.({ cfg: fixture.cfg, to: "~nec", text: chunk });
    }

    expect(outbound.chunkerMode).toBe("markdown");
    expect(chunks).toEqual(["x".repeat(TEXT_LIMIT), "x"]);
    expect(pokes).toHaveLength(chunks.length);
    expect(loginCount).toBeGreaterThan(0);
    expect(rejectedOversized).toBe(0);
    const delivered = pokes.map(storyText);
    expect(delivered.every((part) => part.length <= TEXT_LIMIT)).toBe(true);
    expect(delivered.join("")).toBe(text);
  });

  it("redacts a reflected session cookie from a rejected poke", async () => {
    const cookie = "urbauth-~zod=0v1g.abcde.ijklm.prst";
    const fixture = await listenLoopback((req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`invalid session: ${req.headers.cookie}`);
    });
    fixture.setLogin((res) => {
      res.writeHead(200, { "set-cookie": cookie });
      res.end("ok");
    });
    const error = await fixture
      .send({ text: "reflected credentials" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Poke failed: 500");
    expect(message).toContain("invalid session");
    expect(message).not.toContain(cookie);
  });
});
