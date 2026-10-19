import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeBootstrapController,
  discardRetiredCopilotState,
  prepareRetiredCopilotState,
  requestRelayEnsure,
} from "./native-bootstrap.js";

const CUSTODY_BLOCKED_KEY = "retiredCopilotCustodyBlockedV1";
const RETAINED_LOCAL = {
  relayUrl: "ws://127.0.0.1:18789/extension",
  token: "test-relay-key",
  accessMode: "selected",
  deniedTabIdsV1: [7],
  nativeBootstrapDisabled: true,
};

type CleanupFailureStage =
  | "marker_set"
  | "session_remove"
  | "retired_local_remove"
  | "marker_remove";

function localStorage(values: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(
        keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, values[key]]),
      ),
    ),
    set: vi.fn(async (next: Record<string, unknown>) => {
      Object.assign(values, next);
    }),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        delete values[key];
      }
    }),
  };
}

function nativePort() {
  let message = (_response: unknown) => {};
  let disconnect = () => {};
  return {
    disconnect: vi.fn(() => disconnect()),
    onMessage: {
      addListener: (listener: typeof message) => {
        message = listener;
      },
    },
    onDisconnect: {
      addListener: (listener: typeof disconnect) => {
        disconnect = listener;
      },
    },
    postMessage: vi.fn((_request: { nonce: string }) => {}),
    respond: (response: unknown) => message(response),
  };
}

function cleanupStorage(params: {
  registry?: unknown;
  readError?: Error;
  failureStage?: CleanupFailureStage;
}) {
  let failureStage = params.failureStage;
  const localValues: Record<string, unknown> = {
    copilotDeviceIdentitiesV1: { device: "identity" },
    copilotDeviceTokensV1: { device: "token" },
    ...RETAINED_LOCAL,
    copilotSessionRegistryV1: params.registry,
  };
  const sessionValues: Record<string, unknown> = {
    copilotBrowserInstanceV1: "browser-instance",
    copilotPanelBindingsV1: { 7: "panel-binding" },
  };
  const local = localStorage(localValues);
  const session = localStorage(sessionValues);
  const failAt = (stage: CleanupFailureStage) => {
    if (failureStage === stage) {
      throw new Error(`${stage} failed`);
    }
  };
  const set = local.set.getMockImplementation()!;
  local.set.mockImplementation(async (values) => {
    failAt("marker_set");
    await set(values);
  });
  const remove = local.remove.getMockImplementation()!;
  local.remove.mockImplementation(async (keys) => {
    failAt(keys.includes(CUSTODY_BLOCKED_KEY) ? "marker_remove" : "retired_local_remove");
    await remove(keys);
  });
  const removeSession = session.remove.getMockImplementation()!;
  session.remove.mockImplementation(async (keys) => {
    failAt("session_remove");
    await removeSession(keys);
  });
  if (params.readError) {
    local.get.mockRejectedValue(params.readError);
  }
  return {
    chromeApi: { storage: { local, session } },
    localRemove: local.remove,
    localValues,
    setFailureStage: (next: CleanupFailureStage | undefined) => {
      failureStage = next;
    },
    sessionRemove: session.remove,
    sessionValues,
  };
}

describe("retired copilot custody", () => {
  it("preserves every retired key when the registry read fails", async () => {
    const storage = cleanupStorage({ readError: new Error("storage unavailable") });
    const beforeLocal = structuredClone(storage.localValues);
    const beforeSession = structuredClone(storage.sessionValues);

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({ blocked: true });

    expect(storage.localRemove).not.toHaveBeenCalled();
    expect(storage.sessionRemove).not.toHaveBeenCalled();
    expect(storage.localValues).toEqual(beforeLocal);
    expect(storage.sessionValues).toEqual(beforeSession);
    expect(storage.localValues).toMatchObject(RETAINED_LOCAL);
  });

  it.each<CleanupFailureStage>([
    "marker_set",
    "session_remove",
    "retired_local_remove",
    "marker_remove",
  ])("keeps cleanup restart-safe when %s fails and an explicit retry finishes", async (stage) => {
    const storage = cleanupStorage({
      registry: { sessions: { 7: { creationPending: true } }, pendingArchives: [] },
      failureStage: stage,
    });

    await expect(discardRetiredCopilotState(storage.chromeApi)).rejects.toThrow("failed");
    if (stage === "marker_set") {
      expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
      expect(storage.localValues).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
    } else {
      expect(storage.localValues[CUSTODY_BLOCKED_KEY]).toBe(true);
    }
    if (stage === "session_remove") {
      expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");
    }
    if (stage === "marker_remove") {
      expect(storage.localValues).not.toHaveProperty("copilotSessionRegistryV1");
    }

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: true,
    });
    storage.setFailureStage(undefined);
    await expect(discardRetiredCopilotState(storage.chromeApi)).resolves.toBeUndefined();
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
  });

  it("retries harmless cleanup after session removal fails", async () => {
    const storage = cleanupStorage({
      registry: { sessions: {}, pendingArchives: [] },
      failureStage: "session_remove",
    });

    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: true,
    });
    expect(storage.localValues).not.toHaveProperty(CUSTODY_BLOCKED_KEY);
    expect(storage.localValues).toHaveProperty("copilotSessionRegistryV1");

    storage.setFailureStage(undefined);
    await expect(prepareRetiredCopilotState(storage.chromeApi)).resolves.toEqual({
      blocked: false,
    });
    expect(storage.localValues).toEqual(RETAINED_LOCAL);
    expect(storage.sessionValues).toEqual({});
  });
});

describe("native bootstrap timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["current", "re-enabled"])(
    "settles a stuck native call after %s ownership",
    async (ownership) => {
      vi.useFakeTimers();
      vi.stubGlobal("crypto", {
        getRandomValues: vi.fn((bytes: Uint8Array) => {
          bytes.set(Uint8Array.from({ length: 16 }, (_, index) => index * 17));
          return bytes;
        }),
      });
      const stored: Record<string, unknown> = {};
      const port = nativePort();
      const chromeApi = {
        runtime: { connectNative: vi.fn(() => port) },
        storage: { local: localStorage(stored) },
      };
      const controller = createNativeBootstrapController({
        chromeApi,
        getPairing: async () => null,
        applyPairing: vi.fn(),
      });

      const attempt = controller.attempt();
      await vi.advanceTimersByTimeAsync(0);
      expect(port.postMessage).toHaveBeenCalledWith({
        v: 1,
        op: "bootstrap",
        nonce: "ABEiM0RVZneImaq7zN3u_w",
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(stored).toEqual({});
      if (ownership !== "current") {
        await controller.disableSynchronously();
        await controller.enable({ attemptNow: false });
      }
      await vi.advanceTimersByTimeAsync(1);

      await expect(attempt).resolves.toEqual(
        ownership === "current"
          ? { status: "retrying", code: "native_host_timeout" }
          : { status: "superseded" },
      );
      await expect(controller.status()).resolves.toEqual(
        ownership === "current"
          ? { disabled: false, state: "retrying", failureCode: "native_host_timeout" }
          : { disabled: false, state: "waiting" },
      );
      expect(port.disconnect).toHaveBeenCalledOnce();
    },
  );
});

type EnsurePortScript = (request: { nonce: string }) => unknown;

function ensureChromeApi(script: EnsurePortScript | "disconnect") {
  const connectNative = vi.fn(() => {
    const port = nativePort();
    port.postMessage.mockImplementation((request) => {
      queueMicrotask(() => {
        if (script === "disconnect") {
          port.disconnect();
        } else {
          port.respond(script(request));
        }
      });
    });
    return port;
  });
  return { runtime: { connectNative, lastError: undefined } };
}

describe("requestRelayEnsure", () => {
  it("returns the relay status when the native host answers with the echoed nonce", async () => {
    const chromeApi = ensureChromeApi((request) => {
      expect(request).toEqual({
        v: 1,
        op: "ensure_relay",
        nonce: expect.any(String),
        relayPort: 20123,
      });
      return { v: 1, ok: true, nonce: request.nonce, relay: "spawned" };
    });
    await expect(requestRelayEnsure(20123, chromeApi)).resolves.toEqual({ status: "spawned" });
  });

  it("treats a nonce mismatch as unavailable", async () => {
    const chromeApi = ensureChromeApi(() => ({
      v: 1,
      ok: true,
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      relay: "spawned",
    }));
    await expect(requestRelayEnsure(20123, chromeApi)).resolves.toEqual({ status: "unavailable" });
  });

  it("treats a missing native host as unavailable", async () => {
    await expect(requestRelayEnsure(20123, ensureChromeApi("disconnect"))).resolves.toEqual({
      status: "unavailable",
    });
  });
});
