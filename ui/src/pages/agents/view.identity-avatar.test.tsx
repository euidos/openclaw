import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents, type AgentsProps } from "./view.tsx";

const avatarPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDOsAAAAASUVORK5CYII=";
const identityWithAvatar = {
  beta: { agentId: "beta", name: "Fetched Beta", avatar: "/avatar/beta?v=1", emoji: "" },
};

type AgentAvatarView = ReturnType<typeof mountSolid<AgentsProps>> & { props: AgentsProps };

const views: AgentAvatarView[] = [];
const fetchAvatar = vi.fn<typeof fetch>();
const fetchOther = vi.fn<typeof fetch>();
const createObjectURL = vi.fn<typeof URL.createObjectURL>();
const revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();

beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    console.error(`[settings avatar request URLs] ${JSON.stringify(avatarRequestUrls())}`);
  });
  const nativeFetch = globalThis.fetch;
  fetchAvatar.mockReset();
  fetchOther.mockReset().mockImplementation(nativeFetch);
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      globalThis.location.href,
    );
    // Other mounted UI can fetch resources while this view settles; only the
    // persisted beta avatar belongs to this fixture's request-count contract.
    return url.origin === globalThis.location.origin && url.pathname === "/avatar/beta"
      ? fetchAvatar(input, init)
      : fetchOther(input, init);
  });
  let sequence = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:settings-avatar-${++sequence}`);
  revokeObjectURL.mockReset();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"]);
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dispose();
    view.container.remove();
  }
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function avatarResponse() {
  return new Response(
    Uint8Array.from(atob(avatarPng), (character) => character.charCodeAt(0)),
    {
      headers: { "content-type": "image/png" },
    },
  );
}

function createView(overrides: Partial<ReturnType<typeof createProps>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = createProps({
    agentsList: {
      defaultId: "beta",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "beta", name: "Beta" }],
    },
    agentIdentityById: identityWithAvatar,
    ...overrides,
  });
  const view = { ...mountSolid(Agents, props, container), props };
  views.push(view);
  return view;
}

function avatarRequestUrls() {
  return fetchAvatar.mock.calls.map(([input]) =>
    input instanceof Request ? input.url : String(input),
  );
}

function avatarElement<T extends HTMLElement = HTMLElement>(
  view: AgentAvatarView,
  selector: string,
) {
  return view.container.querySelector<T>(`.agent-identity-editor__avatar ${selector}`);
}
const avatarImage = (view: AgentAvatarView) => avatarElement<HTMLImageElement>(view, "img");
const avatarSrc = (view: AgentAvatarView) => avatarImage(view)?.getAttribute("src");
const avatarClasses = (view: AgentAvatarView) =>
  avatarElement(view, ".identity-avatar--agent")?.classList;
const waitForAvatar = (view: AgentAvatarView, sequence: number) =>
  waitForFast(() => expect(avatarSrc(view)).toBe(`blob:settings-avatar-${sequence}`));

async function expectAvatarFallback(view: AgentAvatarView) {
  await waitForFast(() =>
    expect(avatarElement(view, ".identity-avatar__agent-face")).not.toBeNull(),
  );
  expect(avatarClasses(view)).toContain("is-fallback");
}

function updateView(view: AgentAvatarView, next: Partial<AgentsProps>) {
  view.props = { ...view.props, ...next };
  view.update(view.props);
}

function changeAvatarRevision(view: AgentAvatarView, revision: number) {
  updateView(view, {
    agentIdentityById: {
      beta: { ...identityWithAvatar.beta, avatar: `/avatar/beta?v=${revision}` },
    },
  });
}

function renameView(view: AgentAvatarView) {
  updateView(view, {
    overview: {
      ...view.props.overview,
      identityDraft: { name: "Renamed Beta", emoji: null, avatar: null },
    },
  });
}

it("fetches one persisted settings avatar alongside unrelated requests", async () => {
  const response = createDeferred<Response>();
  fetchAvatar.mockReturnValue(response.promise);
  const view = createView();
  const assetResponse = new Response("independent asset");
  fetchOther.mockResolvedValueOnce(assetResponse);
  const asset = fetch(new URL("/fixture/settings-asset", globalThis.location.origin));

  try {
    const classes = avatarClasses(view);
    expect(classes).toContain("is-pending");
    expect(classes).not.toContain("is-fallback");
    expect(fetchAvatar).toHaveBeenCalledWith(
      `${globalThis.location.origin}/avatar/beta?v=1`,
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer avatar-token" },
        signal: expect.any(AbortSignal),
      }),
    );

    response.resolve(avatarResponse());
    await waitForAvatar(view, 1);
    expect(classes).toContain("is-pending");
    avatarImage(view)?.dispatchEvent(new Event("load"));
    flush();
    expect(classes).not.toContain("is-pending");
    expect(avatarRequestUrls(), "requests after the persisted avatar loads").toEqual([
      globalThis.location.origin + "/avatar/beta?v=1",
    ]);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(await asset).toBe(assetResponse);
  } finally {
    response.resolve(avatarResponse());
  }
});

it("renders the upload preview without fetching the persisted settings avatar", () => {
  const preview = `data:image/png;base64,${avatarPng}`;
  const view = createView({
    overview: {
      ...createProps().overview,
      identityDraft: { name: null, emoji: null, avatar: preview },
    },
  });

  expect(avatarSrc(view)).toBe(preview);
  expect(fetchAvatar).not.toHaveBeenCalled();
});

it("keeps a missing settings avatar on its fallback and recovers on a new revision", async () => {
  const expectedRequests = [1, 2].map(
    (revision) => globalThis.location.origin + "/avatar/beta?v=" + revision,
  );
  fetchAvatar
    .mockResolvedValueOnce(avatarResponse())
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(avatarResponse());
  const view = createView();
  await waitForAvatar(view, 1);

  changeAvatarRevision(view, 2);
  await waitForFast(() =>
    expect(avatarRequestUrls(), "requests after selecting the missing revision").toEqual(
      expectedRequests,
    ),
  );
  await waitForFast(() => expect(avatarImage(view)).toBeNull());
  renameView(view);
  expect(avatarImage(view)).toBeNull();
  await expectAvatarFallback(view);
  expect(avatarRequestUrls(), "requests after showing the fallback and editing the name").toEqual(
    expectedRequests,
  );

  changeAvatarRevision(view, 3);
  await waitForAvatar(view, 2);
  expect(avatarRequestUrls()).toEqual([
    ...expectedRequests,
    globalThis.location.origin + "/avatar/beta?v=3",
  ]);
});

it("keeps a decode failure on its fallback across rerenders until the revision changes", async () => {
  fetchAvatar.mockImplementation(async () => avatarResponse());
  const view = createView();
  await waitForAvatar(view, 1);
  const failedImage = avatarImage(view);
  failedImage?.dispatchEvent(new Event("error"));
  await waitForFast(() => expect(avatarImage(view)).toBeNull());
  await expectAvatarFallback(view);

  renameView(view);
  expect(avatarImage(view)).toBeNull();
  await expectAvatarFallback(view);
  expect(fetchAvatar).toHaveBeenCalledOnce();

  changeAvatarRevision(view, 2);
  await waitForAvatar(view, 2);
  failedImage?.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(avatarSrc(view)).toBe("blob:settings-avatar-2");
  expect(fetchAvatar).toHaveBeenCalledTimes(2);
});

it("keeps a reopened picker preview pending until the authenticated avatar resolves", async () => {
  const response = createDeferred<Response>();
  fetchAvatar.mockReturnValue(response.promise);
  const view = createView();
  const chooser = view.container.querySelector<HTMLButtonElement>(
    'button[aria-label="Edit avatar"]',
  );
  if (!chooser) {
    throw new Error("Missing avatar chooser");
  }
  chooser.click();
  flush();
  view.container.querySelector<HTMLButtonElement>(".avatar-picker__tab:nth-child(2)")?.click();
  flush();
  const preview = view.container.querySelector(".avatar-picker__preview .identity-avatar--agent");
  const image = preview?.querySelector("img");
  expect(preview?.classList).toContain("is-pending");
  expect(image?.getAttribute("src")).toBeNull();
  expect(fetchAvatar).toHaveBeenCalledOnce();
  response.resolve(avatarResponse());
  await waitForFast(() => expect(image?.getAttribute("src")).toBe("blob:settings-avatar-1"));
  image?.dispatchEvent(new Event("load"));
  flush();
  expect(preview?.classList).not.toContain("is-pending");
  expect(fetchAvatar).toHaveBeenCalledOnce();
});
