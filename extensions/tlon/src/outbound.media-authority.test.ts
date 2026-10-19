import type { ChannelMessageSendResult } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tlonPlugin } from "./channel.js";

const IMAGE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5x0AAAAASUVORK5CYII=",
  "base64",
);
const RECIPIENT = "~sampel-palnet";
type Storage = "memex" | "s3";
const scries = {
  "/~/login": "login",
  "/~/scry/storage/configuration.json": "storage",
  "/~/scry/storage/credentials.json": "credentials",
  "/~/scry/genuine/secret.json": "secret",
} as const;
type Phase = (typeof scries)[keyof typeof scries] | "source" | "allocation" | "upload" | "poke";
type RequestRecord = { phase: Phase; url: string; dispatchCount: number };
let cleanup: (() => Promise<void>) | undefined;

function createAccount(ship: string, storage: Storage) {
  const requests: RequestRecord[] = [];
  const pokes: unknown[] = [];
  return {
    ship,
    storage,
    shipUrl: `https://${ship}.${storage === "memex" ? "tlon.network" : "ship.example"}`,
    sourceUrl: `https://media.example/${ship}.png`,
    allocationUrl: `https://memex.tlon.network/v1/${ship}/upload`,
    uploadUrl: `https://uploads.tlon.network/${ship}/upload`,
    hostedUrl: `https://files.tlon.network/${ship}/image.png`,
    s3Endpoint: `https://${ship}.s3.example`,
    publicUrlBase: `https://${ship}.files.example/`,
    code: `fake-code-${ship}`,
    cookie: `urbauth-~${ship}=fake-cookie-${ship}`,
    accessKeyId: `TESTACCESSKEY${ship.toUpperCase()}`,
    controller: new AbortController(),
    revoked: new Error(`Tlon ${ship} delivery authority revoked`),
    onPlatformSendDispatch: vi.fn(async () => {}),
    uploadCanceled: vi.fn(),
    requests,
    pokes,
  };
}

type Account = ReturnType<typeof createAccount>;

function requestJson(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a Tlon JSON request body");
  }
  return JSON.parse(init.body);
}

async function fixtureResponse(
  account: Account,
  phase: Phase,
  init: RequestInit | undefined,
  failUpload: boolean,
) {
  const credentials = {
    endpoint: account.s3Endpoint,
    accessKeyId: account.accessKeyId,
    secretAccessKey: `fake-secret-${account.ship}`,
  };
  const scryResponses = {
    storage: {
      currentBucket: "media",
      region: "us-east-1",
      publicUrlBase: account.publicUrlBase,
      service: account.storage === "memex" ? "presigned-url" : "credentials",
    },
    credentials: { "storage-update": account.storage === "memex" ? {} : { credentials } },
    secret: { secret: `fake-genuine-${account.ship}` },
  };
  switch (phase) {
    case "source":
      return new Response(IMAGE, { headers: { "Content-Type": "image/png" } });
    case "login":
      expect(init?.body).toBe(`password=${account.code}`);
      return new Response("ok", { headers: { "Set-Cookie": account.cookie } });
    case "storage":
    case "credentials":
    case "secret":
      return Response.json(scryResponses[phase]);
    case "allocation":
      expect(requestJson(init)).toMatchObject({
        token: `fake-genuine-${account.ship}`,
        contentLength: IMAGE.byteLength,
        contentType: "image/png",
        fileName: expect.stringMatching(new RegExp(`^${account.ship}/.+-${account.ship}\\.png$`)),
      });
      return Response.json({ url: account.uploadUrl, filePath: account.hostedUrl });
    case "upload":
      if (init?.body == null) {
        throw new Error("Expected the Tlon image upload body");
      }
      expect(Buffer.from(await new Response(init.body).arrayBuffer())).toEqual(IMAGE);
      return new Response(new ReadableStream<Uint8Array>({ cancel: account.uploadCanceled }), {
        status: failUpload ? 503 : 200,
      });
    case "poke":
      account.pokes.push(requestJson(init));
      return new Response(null, { status: 204 });
  }
}

function createFixture(
  accounts: Account[],
  pauseAt?: { ship: string; phase: Phase },
  failUpload = false,
) {
  const entered = createDeferred<Response>();
  const resume = createDeferred<void>();
  const pending: Promise<unknown>[] = [];
  cleanup = async () => {
    for (const account of accounts) {
      account.controller.abort(account.revoked);
    }
    resume.resolve();
    await Promise.allSettled(pending);
  };
  const configuredAccounts = Object.fromEntries(
    accounts.map(({ ship, shipUrl: url, code }) => [
      ship,
      { ship: `~${ship}`, url, code, mediaMaxMb: 1 },
    ]),
  );
  const cfg = { channels: { tlon: { accounts: configuredAccounts } } } satisfies OpenClawConfig;
  const routes = new Map<string, { account: Account; phase: Phase }>();
  for (const account of accounts) {
    const paths: [string, Phase][] = [
      [account.sourceUrl, "source"],
      [account.allocationUrl, "allocation"],
      [account.uploadUrl, "upload"],
      [account.s3Endpoint, "upload"],
      [`${account.shipUrl}/~/channel/`, "poke"],
      ...Object.entries(scries).map(([path, phase]): [string, Phase] => [
        account.shipUrl + path,
        phase,
      ]),
    ];
    for (const [url, phase] of paths) {
      routes.set(url, { account, phase });
    }
  }

  // Only the final HTTP boundary is replaced; registration, preparation,
  // authentication, signing, and the guarded-fetch request check remain real.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const key = url.pathname.startsWith("/~/channel/") ? `${url.origin}/~/channel/` : url.href;
      const route = routes.get(key) ?? routes.get(url.origin);
      if (!route) {
        throw new Error(`Unexpected Tlon fixture request: ${url.origin}${url.pathname}`);
      }
      const { account, phase } = route;
      account.requests.push({
        phase,
        url: url.href,
        dispatchCount: account.onPlatformSendDispatch.mock.calls.length,
      });
      const method = init?.method ?? "GET";
      expect(method).toBe(
        phase === "login"
          ? "POST"
          : ["allocation", "upload", "poke"].includes(phase)
            ? "PUT"
            : "GET",
      );
      if (url.origin === account.shipUrl && phase !== "login") {
        expect(new Headers(init?.headers).get("cookie")).toContain(account.cookie);
      }

      const response = await fixtureResponse(account, phase, init, failUpload);
      if (pauseAt?.ship === account.ship && pauseAt.phase === phase) {
        entered.resolve(response);
        await resume.promise;
      }
      return response;
    }),
  );

  const send = expectDefined(tlonPlugin.message?.send?.media, "preferred Tlon media sender");
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    send: (account: Account) => {
      const result = send({
        cfg,
        accountId: account.ship,
        to: RECIPIENT,
        text: `Photo from ${account.ship}`,
        mediaUrl: account.sourceUrl,
        assertDirectAdapterHandoff: () => account.controller.signal.throwIfAborted(),
        onPlatformSendDispatch: account.onPlatformSendDispatch,
      });
      pending.push(result.catch(() => undefined));
      return result;
    },
  };
}

function getUploadedUrl(account: Account): string {
  const uploads = account.requests.filter(({ phase }) => phase === "upload");
  expect(uploads).toHaveLength(1);
  const upload = expectDefined(uploads[0], "image upload before the Tlon poke");
  if (account.storage === "memex") {
    return account.hostedUrl;
  }
  const signed = new URL(upload.url);
  expect(signed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  expect(signed.searchParams.get("X-Amz-Credential")).toMatch(
    new RegExp(`^${account.accessKeyId}/\\d{8}/us-east-1/s3/aws4_request$`),
  );
  expect(signed.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  expect(signed.pathname).toMatch(new RegExp(`^/media/${account.ship}/.+-${account.ship}\\.png$`));
  return new URL(signed.pathname.slice("/media/".length), account.publicUrlBase).href;
}

function expectDelivered(account: Account, result: ChannelMessageSendResult, mediaUrl: string) {
  expect(result).toMatchObject({
    messageId: expect.stringMatching(new RegExp(`^~${account.ship}/`)),
    receipt: { parts: [{ kind: "media" }] },
  });
  expect(account.pokes).toHaveLength(1);
  const memo = {
    author: `~${account.ship}`,
    content: [{ inline: [`Photo from ${account.ship}`] }, { block: { image: { src: mediaUrl } } }],
  };
  expect(account.pokes[0]).toMatchObject([
    {
      action: "poke",
      ship: account.ship,
      app: "chat",
      mark: "chat-dm-action",
      json: {
        ship: RECIPIENT,
        diff: { delta: { add: { memo } } },
      },
    },
  ]);
  expect(account.onPlatformSendDispatch).toHaveBeenCalledTimes(1);
  expect(
    account.requests.every(
      ({ phase, dispatchCount }) => dispatchCount === (phase === "poke" ? 1 : 0),
    ),
  ).toBe(true);
}

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

describe("Tlon preferred media send authority", () => {
  it.each([
    { storage: "memex", phase: "source" },
    { storage: "memex", phase: "allocation" },
    { storage: "s3", phase: "storage" },
    { storage: "s3", phase: "upload" },
  ] satisfies Array<{ storage: Storage; phase: Phase }>)(
    "stops later requests when authority closes during $storage $phase",
    async ({ storage, phase }) => {
      const account = createAccount("zod", storage);
      const fixture = createFixture([account], { ship: account.ship, phase });
      const result = fixture.send(account).catch((error: unknown) => error);
      await fixture.entered;
      const submitted = [...account.requests];
      account.controller.abort(account.revoked);
      fixture.resume();

      expect(await result).toBe(account.revoked);
      expect(account.requests).toEqual(submitted);
      expect(account.pokes).toEqual([]);
      expect(account.onPlatformSendDispatch).not.toHaveBeenCalled();
      if (phase === "upload") {
        expect(account.uploadCanceled).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("retains the original image URL after an ordinary storage failure", async () => {
    const account = createAccount("zod", "memex");
    const fixture = createFixture([account], undefined, true);

    const result = await fixture.send(account);

    expectDelivered(account, result, account.sourceUrl);
    expect(account.requests.filter(({ phase }) => phase === "upload")).toHaveLength(1);
    expect(account.uploadCanceled).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier media send on its own account after another account completes and closes", async () => {
    const first = createAccount("zod", "memex");
    const second = createAccount("nec", "s3");
    const fixture = createFixture([first, second], { ship: first.ship, phase: "source" });
    const firstResult = fixture.send(first);
    await fixture.entered;

    const secondResult = await fixture.send(second);
    expectDelivered(second, secondResult, getUploadedUrl(second));
    const secondRequests = [...second.requests];
    second.controller.abort(second.revoked);
    fixture.resume();

    expectDelivered(first, await firstResult, getUploadedUrl(first));
    expect(second.requests).toEqual(secondRequests);
    expect(first.uploadCanceled).toHaveBeenCalledTimes(1);
    expect(second.uploadCanceled).toHaveBeenCalledTimes(1);
  });
});
