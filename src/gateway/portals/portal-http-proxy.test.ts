import { once } from "node:events";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import { duplexPair, type Duplex } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { mockIpv4OnlyLocalhostLookup } from "../../../test/helpers/loopback-dns.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import type { PortalTarget } from "./portal-http-proxy.js";
import type { GatewayPortalService } from "./portal-service.js";
import { requestText, usePortalHarness } from "./portal.test-support.js";

type HttpResult = Awaited<ReturnType<typeof requestText>>;

const { target, makeService, listenTarget } = usePortalHarness();
let targetWebSocketPath: string | undefined;
let targetWebSocketCookie: string | undefined;
let targetWebSocketHeaders: IncomingMessage["headers"] | undefined;
let targetWebSocketSetCookie: string | undefined;
const targetWss = new WebSocketServer({ server: target.server });

beforeAll(async () => {
  targetWss.on("connection", (socket, req) => {
    targetWebSocketPath = req.url;
    targetWebSocketCookie = req.headers.cookie;
    targetWebSocketHeaders = req.headers;
    socket.on("message", (data) => socket.send(data));
  });
  targetWss.on("headers", (headers) => {
    if (targetWebSocketSetCookie) {
      headers.push(`Set-Cookie: ${targetWebSocketSetCookie}`);
    }
  });
});

afterEach(async () => {
  targetWebSocketPath = undefined;
  targetWebSocketCookie = undefined;
  targetWebSocketHeaders = undefined;
  targetWebSocketSetCookie = undefined;
});

afterAll(() => targetWss.close());

function portalService(httpServers: Server[] = []) {
  return makeService({ httpServers }).service;
}

function openPortal(options: Partial<Parameters<GatewayPortalService["open"]>[0]> = {}) {
  return portalService().open({ targetPort: target.port, ...options });
}

function authenticatedCall(portal: { listenPort: number; tokenQuery: string }, path = "/") {
  return httpCall({ port: portal.listenPort, path, headers: { Cookie: portalAuthCookie(portal) } });
}

async function expectEcho(socket: WebSocket, message: string) {
  const echoed = new Promise<string>((resolve) => {
    socket.once("message", (data) => resolve(data.toString()));
  });
  socket.send(message);
  expect(await echoed).toBe(message);
}

function expectWaiting(result: HttpResult, port: number) {
  expect(result.status).toBe(502);
  expect(result.body).toContain(`Waiting for the app on port ${port}…`);
  expect(result.body).toContain('http-equiv="refresh" content="2"');
}

function cookieTarget(value: string, received: Array<string | undefined> = []) {
  return (req: IncomingMessage, res: ServerResponse) => {
    received.push(req.headers.cookie);
    if (req.url === "/set") {
      res.setHeader("Set-Cookie", `session=${value}; Domain=target.example; Path=/; HttpOnly`);
    }
    res.end(`target-${value}`);
  };
}

function createWorkerStreamPair() {
  const [gatewayStream, workerStream] = duplexPair({ allowHalfOpen: false });
  // WebSocket closure delivers EOF to its peer; Node 22's duplexPair does not forward destroy.
  gatewayStream.once("close", () => workerStream.push(null));
  workerStream.once("close", () => gatewayStream.push(null));
  return [gatewayStream, workerStream] as const;
}

function createWorkerStream(port: number): Duplex {
  const [gatewayStream, workerStream] = createWorkerStreamPair();
  const appSocket = net.connect({ host: "127.0.0.1", port });
  workerStream.on("error", () => appSocket.destroy());
  appSocket.on("error", () => workerStream.destroy());
  workerStream.once("close", () => appSocket.destroy());
  appSocket.once("close", () => workerStream.destroy());
  workerStream.pipe(appSocket).pipe(workerStream);
  return gatewayStream;
}

function workerTarget(connect: () => Promise<Duplex>, remotePort: number): PortalTarget {
  return {
    kind: "worker",
    environmentId: "cloud-worker",
    ownerEpoch: 3,
    remotePort,
    connect,
  };
}

function httpCall(params: {
  port: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  return requestText(
    `http://127.0.0.1:${params.port}${params.path ?? "/"}`,
    { method: params.method, headers: params.headers },
    params.body,
  );
}

async function readUpgradeRejection(params: {
  port: number;
  host?: string;
}): Promise<{ status: number; body: string; elapsedMs: number }> {
  const started = Date.now();
  const socket = net.connect({ host: "127.0.0.1", port: params.port });
  await once(socket, "connect");
  socket.write(
    [
      "GET / HTTP/1.1",
      `Host: ${params.host ?? `127.0.0.1:${params.port}`}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "",
      "",
    ].join("\r\n"),
  );
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  await Promise.race([once(socket, "close"), once(socket, "end")]);
  socket.destroy();
  const raw = Buffer.concat(chunks).toString("utf8");
  const separator = raw.indexOf("\r\n\r\n");
  const head = separator >= 0 ? raw.slice(0, separator) : raw;
  const body = (separator >= 0 ? raw.slice(separator + 4) : "").replace(/\r\n$/u, "");
  return {
    status: Number(head.split(" ")[1]),
    body,
    elapsedMs: Date.now() - started,
  };
}

function storeCookies(jar: Map<string, string>, cookies: readonly string[] | undefined): void {
  for (const cookie of cookies ?? []) {
    const pair = cookie.split(";", 1)[0];
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) {
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
}

function cookieJarHeader(jar: ReadonlyMap<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function portalAuthCookie(portal: { listenPort: number; tokenQuery: string }): string {
  const token = portal.tokenQuery.slice("openclaw_portal=".length);
  return `openclaw_portal_${portal.listenPort}=${token}`;
}

const privateHeaders = {
  Cookie: "openclaw_plugin_tab=secret",
  "Tailscale-User-Login": "private@example.test",
  Forwarded: "host=forged.example;proto=https",
  "Cf-Access-Jwt-Assertion": "synthetic-edge-assertion",
  Authorization: "Bearer synthetic-app-token",
  "X-Remove-Me": "remove",
};

function expectSafeHeaders(headers: IncomingMessage["headers"] | undefined, publicUrl: string) {
  expect(headers).toMatchObject({
    "x-forwarded-host": new URL(publicUrl).host,
    "x-forwarded-proto": "http",
    authorization: privateHeaders.Authorization,
  });
  for (const key of "cookie tailscale-user-login forwarded x-remove-me cf-access-jwt-assertion".split(
    " ",
  )) {
    expect(headers?.[key]).toBeUndefined();
  }
}

async function openWebSocket(
  url: string,
  headers?: Record<string, string>,
  finishRequest?: (req: ClientRequest) => void,
): Promise<{ socket: WebSocket; setCookies: string[] | undefined }> {
  let setCookies: string[] | undefined;
  const socket = new WebSocket(url, { headers, finishRequest });
  socket.once("upgrade", (response) => {
    setCookies = response.headers["set-cookie"];
  });
  await once(socket, "open");
  return { socket, setCookies };
}

async function closeWebSocket(socket: WebSocket): Promise<void> {
  const closed = once(socket, "close");
  socket.close();
  await closed;
}

async function browserCall(
  jar: Map<string, string>,
  portal: { listenPort: number },
  path = "/",
): Promise<HttpResult> {
  const cookie = cookieJarHeader(jar);
  const result = await httpCall({
    port: portal.listenPort,
    path,
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  storeCookies(jar, result.headers["set-cookie"]);
  return result;
}

describe("portal HTTP proxy", () => {
  it("proxies a URL token directly, sets a private cookie, and strips the token", async () => {
    const targetPaths: string[] = [];
    target.handler = (req, res) => {
      targetPaths.push(req.url ?? "/");
      res.statusCode = 200;
      res.end("proxied");
    };
    const portal = await openPortal({ targetPort: target.port, title: "App" });

    const unauthorized = await httpCall({ port: portal.listenPort });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body).toContain("This portal is private");
    expect(unauthorized.body).not.toContain(portal.tokenQuery);
    expect(unauthorized.headers["referrer-policy"]).toBe("no-referrer");

    const unauthorizedUpgrade = await readUpgradeRejection({ port: portal.listenPort });
    expect(unauthorizedUpgrade).toMatchObject({ status: 401, body: "Unauthorized" });
    expect(unauthorizedUpgrade.elapsedMs).toBeLessThan(2000);

    const authorized = await httpCall({
      port: portal.listenPort,
      path: `/preview?x=1&${portal.tokenQuery}`,
    });
    expect(authorized).toMatchObject({ status: 200, body: "proxied" });
    expect(authorized.headers["set-cookie"]?.[0]).toContain(
      `openclaw_portal_${portal.listenPort}=`,
    );
    expect(authorized.headers["set-cookie"]?.[0]).toContain("HttpOnly; SameSite=Lax; Path=/");
    expect(targetPaths).toEqual(["/preview?x=1"]);

    const cookieOnly = await authenticatedCall(portal, "/cookie?y=2");
    expect(cookieOnly).toMatchObject({ status: 200, body: "proxied" });
    expect(targetPaths).toEqual(["/preview?x=1", "/cookie?y=2"]);
  });

  it("flushes HTTP 404 on an unknown portal ingress upgrade instead of hanging", async () => {
    const { service } = makeService({ ingress: { domain: "previews.example.net", port: 0 } });
    const portal = await service.open({ targetPort: target.port, title: "App" });
    const rejected = await readUpgradeRejection({
      port: portal.listenPort,
      host: "missing.previews.example.net",
    });
    expect(rejected).toMatchObject({ status: 404, body: "Unknown portal" });
    expect(rejected.elapsedMs).toBeLessThan(2000);
  });

  it.for(["unauthorized", "unavailable"] as const)(
    "closes the %s upgrade after flushing its response while the client remains open",
    async (failure, { signal }) => {
      const httpServers: Server[] = [];
      const service = portalService(httpServers);
      const portal = await service.open({
        targetPort: target.port,
        target: workerTarget(async () => {
          throw new Error("Worker unavailable");
        }, target.port),
      });
      const upgraded = createDeferredCore<Duplex>();
      httpServers[0]!.once("upgrade", (_req, socket) => upgraded.resolve(socket));
      const client = net.connect({
        host: "127.0.0.1",
        port: portal.listenPort,
        allowHalfOpen: true,
      });
      try {
        const chunks: Buffer[] = [];
        client.on("data", (chunk: Buffer) => chunks.push(chunk));
        await once(client, "connect", { signal });
        const ended = once(client, "end", { signal });
        const query = failure === "unavailable" ? `?${portal.tokenQuery}` : "";
        client.write(
          `GET /${query} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
        );
        const serverSocket = await upgraded.promise;
        await ended;
        const response = Buffer.concat(chunks).toString("utf8");
        expect(response).toContain(
          failure === "unauthorized" ? "HTTP/1.1 401 Unauthorized" : "HTTP/1.1 502 Bad Gateway",
        );
        expect(serverSocket.destroyed).toBe(true);
        expect(client.writableEnded).toBe(false);
      } finally {
        client.destroy();
      }
    },
  );

  it("streams HTTP requests and responses with rewritten safe headers", async () => {
    let receivedHeaders: IncomingMessage["headers"] | undefined;
    let receivedBody = "";
    target.handler = (req, res) => {
      receivedHeaders = req.headers;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (receivedBody += chunk));
      res.statusCode = 201;
      res.setHeader("Connection", "keep-alive, x-target-hop");
      res.setHeader("Keep-Alive", "upstream-secret=17");
      res.setHeader("X-Target-Hop", "remove");
      res.setHeader("X-App", "kept");
      res.setHeader("Referrer-Policy", "unsafe-url");
      req.once("end", () => {
        res.write("hello ");
        res.end("portal");
      });
    };
    const portal = await openPortal();
    const result = await httpCall({
      port: portal.listenPort,
      path: "/asset?q=1",
      method: "POST",
      body: "streamed request",
      headers: {
        ...privateHeaders,
        Host: "portal.example:9999",
        Cookie: `openclaw_plugin_tab=secret; ${portalAuthCookie(portal)}`,
        Connection: "keep-alive, x-remove-me",
        "X-Forwarded-Port": "444",
        "X-Real-IP": "192.0.2.1",
        "Cf-Access-Client-Secret": "synthetic-edge-secret",
        Referer: `http://127.0.0.1:${portal.listenPort}/?${portal.tokenQuery}`,
      },
    });

    expect(result).toMatchObject({ status: 201, body: "hello portal" });
    expect(receivedBody).toBe("streamed request");
    expect(result.headers["x-app"]).toBe("kept");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["x-target-hop"]).toBeUndefined();
    // Node may add its own connection-local Keep-Alive header; the upstream value must not pass.
    expect(result.headers["keep-alive"]).not.toBe("upstream-secret=17");
    expectSafeHeaders(receivedHeaders, portal.publicUrl);
    expect(receivedHeaders).toMatchObject({
      host: `localhost:${target.port}`,
      "x-forwarded-for": expect.stringMatching(/127\.0\.0\.1|::ffff:127\.0\.0\.1/u),
    });
    for (const key of ["referer", "cf-access-client-secret", "x-forwarded-port", "x-real-ip"]) {
      expect(receivedHeaders?.[key]).toBeUndefined();
    }
  });

  it("keeps A-B-A sessions authorized while forwarding only each target's prefixed cookies", async () => {
    const receivedCookiesA: Array<string | undefined> = [];
    target.handler = cookieTarget("a", receivedCookiesA);
    const receivedCookiesB: Array<string | undefined> = [];
    const targetPortB = await listenTarget(cookieTarget("b", receivedCookiesB));
    const service = portalService();
    const portalA = await service.open({ targetPort: target.port });
    const portalB = await service.open({ targetPort: targetPortB });
    const jar = new Map<string, string>();

    const initialA = await browserCall(jar, portalA, `/set?${portalA.tokenQuery}`);
    const initialB = await browserCall(jar, portalB, `/set?${portalB.tokenQuery}`);
    expect(initialA).toMatchObject({ status: 200, body: "target-a" });
    expect(initialB).toMatchObject({ status: 200, body: "target-b" });
    const targetCookieA = initialA.headers["set-cookie"]?.find((cookie) =>
      cookie.startsWith("oc_portal_"),
    );
    const targetCookieB = initialB.headers["set-cookie"]?.find((cookie) =>
      cookie.startsWith("oc_portal_"),
    );
    expect(targetCookieA).toMatch(/^oc_portal_[a-f0-9]{32}_session=a; Path=\/; HttpOnly$/u);
    expect(targetCookieB).toMatch(/^oc_portal_[a-f0-9]{32}_session=b; Path=\/; HttpOnly$/u);
    expect(targetCookieA?.split("_session=", 1)[0]).not.toBe(
      targetCookieB?.split("_session=", 1)[0],
    );
    expect(
      [...(initialA.headers["set-cookie"] ?? []), ...(initialB.headers["set-cookie"] ?? [])].join(
        "; ",
      ),
    ).not.toContain("Domain=");
    expect([...jar.keys()].filter((name) => name.startsWith("openclaw_portal"))).toEqual([
      `openclaw_portal_${portalA.listenPort}`,
      `openclaw_portal_${portalB.listenPort}`,
    ]);

    for (const [portal, body] of [
      [portalA, "target-a"],
      [portalB, "target-b"],
      [portalA, "target-a"],
    ] as const) {
      expect(await browserCall(jar, portal)).toMatchObject({
        status: 200,
        body,
      });
    }
    expect(receivedCookiesA).toEqual([undefined, "session=a", "session=a"]);
    expect(receivedCookiesB).toEqual([undefined, "session=b"]);
  });

  it("does not forward cookies from a closed portal when its target port is reused", async () => {
    target.handler = (_req, res) => {
      res.setHeader("Set-Cookie", "session=portal-a-secret; Path=/; HttpOnly");
      res.end("target-a");
    };
    const service = portalService();
    const portalA = await service.open({ targetPort: target.port });
    const jar = new Map<string, string>();
    await browserCall(jar, portalA, `/?${portalA.tokenQuery}`);
    await service.close(portalA.id);

    const receivedCookiesB: Array<string | undefined> = [];
    target.handler = (req, res) => {
      receivedCookiesB.push(req.headers.cookie);
      if (req.url === "/set") {
        res.setHeader("Set-Cookie", "session=portal-b; Path=/; HttpOnly");
      }
      res.end("target-b");
    };
    const portalB = await service.open({ targetPort: target.port });
    expect(portalB.tokenQuery).not.toBe(portalA.tokenQuery);

    await browserCall(jar, portalB, `/?${portalB.tokenQuery}`);
    await browserCall(jar, portalB, "/set");
    await browserCall(jar, portalB);

    expect(receivedCookiesB).toEqual([undefined, undefined, "session=portal-b"]);
  });

  it.each(["loopback", "/nested/page?q=1", "https://accounts.example.test/login"])(
    "handles the %s redirect on the published origin",
    async (redirect) => {
      const path = "/nested/page?q=1#section";
      const location =
        redirect === "loopback" ? `http://localhost:${target.port}${path}` : redirect;
      target.handler = (_req, res) => {
        res.writeHead(302, { Location: location }).end();
      };
      const portal = await openPortal();
      const response = await authenticatedCall(portal);
      expect(response).toMatchObject({
        status: 302,
        headers: {
          location: redirect === "loopback" ? new URL(path, portal.publicUrl).href : location,
        },
      });
    },
  );

  it("shows a retry page when the target closes the connection", async () => {
    target.handler = (_req, res) => res.destroy();
    const portal = await openPortal();

    expectWaiting(await authenticatedCall(portal), target.port);
  });

  it("proxies worker HTTP and WebSocket traffic through a fresh paired duplex per connection", async () => {
    const remotePort = 4173;
    let receivedHost: string | undefined;
    let connectionCount = 0;
    target.handler = (req, res) => {
      receivedHost = req.headers.host;
      res.end("worker proxied");
    };
    const portal = await openPortal({
      targetPort: remotePort,
      target: workerTarget(async () => {
        connectionCount += 1;
        return createWorkerStream(target.port);
      }, remotePort),
    });

    expect(
      await httpCall({ port: portal.listenPort, path: `/preview?${portal.tokenQuery}` }),
    ).toMatchObject({ status: 200, body: "worker proxied" });
    expect(receivedHost).toBe(`localhost:${remotePort}`);

    const { socket } = await openWebSocket(
      `ws://127.0.0.1:${portal.listenPort}/hmr?${portal.tokenQuery}`,
    );
    await expectEcho(socket, "worker hot reload");
    expect(targetWebSocketPath).toBe("/hmr");
    expect(connectionCount).toBe(2);
    await closeWebSocket(socket);
  });

  it("waits for asynchronous worker stream attachment before forwarding the HTTP request", async () => {
    target.handler = (req, res) => {
      res.end(`worker ${req.url}`);
    };
    const dialStarted = createDeferredCore();
    const dialReleased = createDeferredCore();
    const remotePort = 4173;
    const portal = await openPortal({
      targetPort: remotePort,
      target: workerTarget(async () => {
        dialStarted.resolve();
        await dialReleased.promise;
        return createWorkerStream(target.port);
      }, remotePort),
    });

    const response = httpCall({
      port: portal.listenPort,
      path: `/slow?${portal.tokenQuery}`,
    });
    await dialStarted.promise;
    dialReleased.resolve();

    expect(await response).toMatchObject({ status: 200, body: "worker /slow" });
  });

  it("contains browser socket errors while a worker WebSocket is attaching", async () => {
    target.handler = (_req, res) => res.end("still available");
    const httpServers: Server[] = [];
    const service = portalService(httpServers);
    const dialing = createDeferredCore();
    const attachment = createDeferredCore<Duplex>();
    let firstConnection = true;
    const portal = await service.open({
      targetPort: target.port,
      target: workerTarget(async () => {
        if (!firstConnection) {
          return createWorkerStream(target.port);
        }
        firstConnection = false;
        dialing.resolve();
        return await attachment.promise;
      }, target.port),
    });
    const upgrade = createDeferredCore<Duplex>();
    httpServers[0]!.once("upgrade", (_req, socket) => upgrade.resolve(socket));
    const browser = net.connect({ host: "127.0.0.1", port: portal.listenPort });
    const [lateStream, peer] = createWorkerStreamPair();
    let transport: Duplex | undefined;
    try {
      await once(browser, "connect");
      browser.write(
        `GET /hmr?${portal.tokenQuery} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      await dialing.promise;
      transport = await upgrade.promise;
      const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      expect(() => transport!.emit("error", reset)).not.toThrow();
      expect(transport.destroyed).toBe(true);
      const lateClosed = once(lateStream, "close");
      attachment.resolve(lateStream);
      await lateClosed;
      expect(lateStream.destroyed).toBe(true);
      expect(await authenticatedCall(portal)).toMatchObject({
        status: 200,
        body: "still available",
      });
    } finally {
      attachment.resolve(lateStream);
      browser.destroy();
      transport?.destroy();
      lateStream.destroy();
      peer.destroy();
    }
  });

  it.each([
    ["local", "browser"],
    ["worker", "browser"],
    ["local", "app"],
    ["worker", "app"],
  ] as const)("closes both sides when the %s portal's %s disconnects", async (kind, disconnect) => {
    let appResponse: ServerResponse | undefined;
    let appClosed = false;
    target.handler = (_req, res) => {
      appResponse = res;
      res.once("close", () => {
        appClosed = true;
      });
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: ready\n\n");
    };
    const portal = await openPortal({
      targetPort: target.port,
      ...(kind === "worker"
        ? {
            target: workerTarget(async () => createWorkerStream(target.port), target.port),
          }
        : {}),
    });
    const browserResponse = await new Promise<IncomingMessage>((resolve, reject) => {
      const browserRequest = request(portal.url, (res) => {
        res.on("error", () => undefined);
        res.once("data", () => resolve(res));
      });
      browserRequest.once("error", reject);
      browserRequest.end();
    });
    try {
      (disconnect === "browser" ? browserResponse : appResponse)?.destroy();
      await vi.waitFor(() => {
        expect(browserResponse.destroyed).toBe(true);
        expect(appClosed).toBe(true);
      });
    } finally {
      browserResponse.destroy();
      appResponse?.destroy();
    }
  });

  it.each([
    ["local", "complete"],
    ["worker", "complete"],
    ["local", "abort"],
    ["worker", "abort"],
  ] as const)(
    "delivers %s response headers before the first body chunk and handles %s",
    async (kind, completion) => {
      let appResponse: ServerResponse | undefined;
      target.handler = (req, res) => {
        if (req.url === "/events") {
          appResponse = res;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("X-App", "header-first");
          res.flushHeaders();
          return;
        }
        if (req.url === "/start" && req.method === "POST" && appResponse) {
          res.writeHead(204).end();
          if (completion === "complete") {
            appResponse.end("data: started\n\n");
          } else {
            appResponse.destroy();
          }
          return;
        }
        res.writeHead(404).end();
      };
      const portal = await openPortal({
        targetPort: target.port,
        ...(kind === "worker"
          ? { target: workerTarget(async () => createWorkerStream(target.port), target.port) }
          : {}),
      });
      const connection = {
        host: "127.0.0.1",
        port: portal.listenPort,
        headers: { Cookie: portalAuthCookie(portal) },
      };
      const browserRequest = request({
        ...connection,
        path: "/events",
        signal: AbortSignal.timeout(3_000),
      });
      const responseHeaders = new Promise<IncomingMessage>((resolve, reject) => {
        browserRequest.once("response", resolve);
        browserRequest.once("error", reject);
      });
      browserRequest.end();
      try {
        // An idle event stream opens before the client asks the app to produce data.
        const browserResponse = await responseHeaders;
        expect(browserResponse.statusCode).toBe(200);
        expect(browserResponse.headers["content-type"]).toBe("text/event-stream");
        expect(browserResponse.headers["x-app"]).toBe("header-first");
        const chunks: Buffer[] = [];
        const responseClosed = new Promise<void>((resolve) => {
          browserResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
          browserResponse.on("error", () => undefined);
          browserResponse.once("close", resolve);
        });
        expect(await httpCall({ ...connection, path: "/start", method: "POST" })).toMatchObject({
          status: 204,
        });
        await responseClosed;
        expect(browserResponse.statusCode).toBe(200);
        expect(browserResponse.complete).toBe(completion === "complete");
        expect(Buffer.concat(chunks).toString("utf8")).toBe(
          completion === "complete" ? "data: started\n\n" : "",
        );
      } finally {
        browserRequest.destroy();
        appResponse?.destroy();
      }
    },
  );

  it.each(["rejected", "closed", "reset"] as const)(
    "shows the worker retry page for HTTP and upgrades when its node stream is %s",
    async (streamState) => {
      const remotePort = 4173;
      const connect = async (): Promise<Duplex> => {
        if (streamState === "rejected") {
          throw new Error("Worker node stream unavailable");
        }
        const [gatewayStream, workerStream] = createWorkerStreamPair();
        if (streamState === "closed") {
          workerStream.end();
        } else {
          workerStream.destroy();
        }
        return gatewayStream;
      };
      const portal = await openPortal({
        targetPort: remotePort,
        target: workerTarget(connect, remotePort),
      });
      const cookie = portalAuthCookie(portal);
      const requestHeaders: Record<string, string>[] = [
        { Cookie: cookie },
        { Cookie: cookie, Connection: "Upgrade", Upgrade: "websocket" },
      ];

      for (const headers of requestHeaders) {
        const result = await httpCall({ port: portal.listenPort, headers });
        expectWaiting(result, remotePort);
      }
    },
  );

  it("reaches IPv6-only targets through the localhost dual-stack dial", async () => {
    mockIpv4OnlyLocalhostLookup();
    // Node >=17 dev servers (Vite, Next.js) often bind ::1 only on "localhost".
    // Keep the IPv4 endpoint unclaimed by sibling fixtures while only IPv6 is bound.
    const claim = await acquireTestPortBlock({ offsets: [0] });
    const v6Port = claim.port;
    const v6Target = createServer((req, res) => {
      res.statusCode = 200;
      res.end("v6 proxied");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        v6Target.once("error", reject);
        v6Target.listen(v6Port, "::1", () => resolve());
      });
      const portal = await openPortal({ targetPort: v6Port });
      const result = await httpCall({
        port: portal.listenPort,
        path: `/?${portal.tokenQuery}`,
      });
      expect(result).toMatchObject({ status: 200, body: "v6 proxied" });
    } finally {
      await new Promise<void>((resolve) => {
        v6Target.close(() => resolve());
      });
      await claim.release();
    }
  });

  it("splices WebSockets and destroys upgraded sockets and listeners on close", async () => {
    const service = portalService();
    const portal = await service.open({ targetPort: target.port });
    targetWebSocketSetCookie = "socket=ready; Domain=target.example; Path=/; HttpOnly";
    const { socket: ws, setCookies: upgradeCookies } = await openWebSocket(
      `ws://127.0.0.1:${portal.listenPort}/hmr?channel=dev&${portal.tokenQuery}`,
      {
        ...privateHeaders,
        "X-Forwarded-Host": "forged.example",
        "X-Forwarded-Proto": "https",
        Forwarded: "host=forged.example",
        "Cf-Access-Authenticated-User-Email": "private@example.test",
      },
      (req) => {
        // ws installs its own Connection header after user headers.
        req.setHeader("Connection", "Upgrade, x-remove-me");
        req.end();
      },
    );
    await expectEcho(ws, "hot reload");
    expect(targetWebSocketPath).toBe("/hmr?channel=dev");
    expectSafeHeaders(targetWebSocketHeaders, portal.publicUrl);
    expect(targetWebSocketHeaders?.["cf-access-authenticated-user-email"]).toBeUndefined();
    expect(upgradeCookies).toHaveLength(1);
    expect(upgradeCookies?.[0]).toMatch(
      /^oc_portal_[a-f0-9]{32}_socket=ready; Path=\/; HttpOnly$/u,
    );

    const closed = once(ws, "close");
    await service.close(portal.id);
    await closed;
    await expect(httpCall({ port: portal.listenPort })).rejects.toThrow();
  });

  it("keeps portal A WebSocket authorized after portal B replaces the active URL", async () => {
    target.handler = (_req, res) => {
      res.statusCode = 200;
      res.end("target-a");
    };
    const targetPortB = await listenTarget((_req, res) => {
      res.statusCode = 200;
      res.end("target-b");
    });
    const service = portalService();
    const portalA = await service.open({ targetPort: target.port });
    const portalB = await service.open({ targetPort: targetPortB });
    const jar = new Map<string, string>();
    await browserCall(jar, portalA, `/?${portalA.tokenQuery}`);
    await browserCall(jar, portalB, `/?${portalB.tokenQuery}`);

    const { socket: ws } = await openWebSocket(
      `ws://127.0.0.1:${portalA.listenPort}/hmr?channel=dev`,
      { Cookie: cookieJarHeader(jar) },
    );
    await expectEcho(ws, "portal-a");
    expect(targetWebSocketPath).toBe("/hmr?channel=dev");
    await closeWebSocket(ws);
  });

  it("does not forward WebSocket cookies from a closed portal when its target port is reused", async () => {
    const service = portalService();
    const portalA = await service.open({ targetPort: target.port });
    targetWebSocketSetCookie = "socket=portal-a-secret; Path=/; HttpOnly";
    const connectionA = await openWebSocket(
      `ws://127.0.0.1:${portalA.listenPort}/hmr?${portalA.tokenQuery}`,
    );
    const jar = new Map<string, string>();
    storeCookies(jar, connectionA.setCookies);
    await closeWebSocket(connectionA.socket);
    await service.close(portalA.id);

    const portalB = await service.open({ targetPort: target.port });
    targetWebSocketSetCookie = "socket=portal-b; Path=/; HttpOnly";
    const connectionB = await openWebSocket(
      `ws://127.0.0.1:${portalB.listenPort}/hmr?${portalB.tokenQuery}`,
      { Cookie: cookieJarHeader(jar) },
    );
    expect(targetWebSocketCookie).toBeUndefined();
    storeCookies(jar, connectionB.setCookies);
    await closeWebSocket(connectionB.socket);

    const connectionBAgain = await openWebSocket(
      `ws://127.0.0.1:${portalB.listenPort}/hmr?${portalB.tokenQuery}`,
      { Cookie: cookieJarHeader(jar) },
    );
    expect(targetWebSocketCookie).toBe("socket=portal-b");
    await closeWebSocket(connectionBAgain.socket);
  });
});
