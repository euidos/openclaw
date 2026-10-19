import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import {
  captureClientVoiceSessionSettlement,
  withClientVoiceSessionSettlement,
} from "../../../talk/client-voice-session-lifecycle.js";
import { createClientVoiceTranscriptReadiness } from "../../../talk/client-voice-transcript-readiness.js";
import { VOICE_TRANSCRIPT_QUEUE_POLICY } from "../../../talk/voice-transcript.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { RelaySession } from "./state.js";
import {
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
  ensureRelayVoiceSession,
} from "./voice.js";

const voiceSessionMocks = vi.hoisted(() => ({
  appendRelayVoiceTranscript: vi.fn(),
  closeRelayVoiceSessionRecord: vi.fn(),
  createOrResumeClientVoiceSession: vi.fn(),
  captureClientVoiceSessionWriter: vi.fn(),
  captureClientVoiceSessionSource: vi.fn(),
}));

// mock-isolation: The queue policy is exercised without durable voice state.
vi.mock("../../../talk/client-voice-session.js", () => voiceSessionMocks);
// mock-isolation: Queue-only cases bypass state admission; the refusal regression restores it.
vi.mock("../../../talk/client-voice-session-lifecycle.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../talk/client-voice-session-lifecycle.js")>();
  return {
    ...actual,
    withClientVoiceSessionSettlement: vi.fn(actual.withClientVoiceSessionSettlement),
  };
});
// mock-isolation: The mocked voice store has no physical database to borrow.
vi.mock("../../../talk/client-voice-session-write.js", () => ({
  captureClientVoiceSessionWriter: voiceSessionMocks.captureClientVoiceSessionWriter,
}));
// mock-isolation: The queue-only fixture has no physical voice database to capture.
vi.mock("../../../talk/client-voice-session-source.js", () => ({
  captureClientVoiceSessionSource: voiceSessionMocks.captureClientVoiceSessionSource,
}));
// mock-isolation: Exercise retry decisions without wall-clock backoff.
vi.mock("../../../utils/sleep.js", () => ({ sleep: async () => {} }));

const {
  appendRelayVoiceTranscript: appendTranscript,
  closeRelayVoiceSessionRecord: closeRecord,
  createOrResumeClientVoiceSession: createVoice,
  captureClientVoiceSessionWriter: captureWriter,
  captureClientVoiceSessionSource: captureSource,
} = voiceSessionMocks;

function createRelaySession(refuseCloseSource = false) {
  const failSession = vi.fn(() => {
    if (refuseCloseSource) {
      const capture = captureWriter.getMockImplementation()!;
      captureWriter.mockImplementation((...args) => {
        if (session.voiceTranscriptQueue.isIdle) {
          throw new Error("Voice source was replaced before close");
        }
        return capture(...args);
      });
    }
    void closeRelayVoiceSession(session);
  });
  const session = {
    id: "relay-voice-bounded",
    sessionTarget: {
      agentId: "main",
      sessionKey: "main",
      canonicalKey: "agent:main:work",
      storePath: "/tmp/relay-voice-sessions.sqlite",
      assertCurrent: () => {},
    },
    provider: "openai",
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    transcriptReadiness: createClientVoiceTranscriptReadiness({
      flushTranscript: async () => await session.voiceTranscriptQueue.flush(),
    }),
    voiceSessionCreated: false,
    voiceTranscriptSeq: 0,
    voiceTranscriptQueue: VOICE_TRANSCRIPT_QUEUE_POLICY.createQueue(),
    failSession,
  } as unknown as RelaySession;
  return { session, failSession };
}

function expectWarning(session: RelaySession, message: string) {
  expect(session.context.logGateway.warn).toHaveBeenCalledWith(expect.stringContaining(message));
}

describe("realtime relay voice transcript persistence", () => {
  beforeEach(() => {
    vi.mocked(withClientVoiceSessionSettlement).mockImplementation((run) => run());
    appendTranscript.mockReset();
    closeRecord.mockReset().mockResolvedValue(undefined);
    createVoice.mockReset().mockResolvedValue("voice");
    const source = { assertCurrent: () => {} };
    captureSource.mockReset().mockReturnValue(source);
    captureWriter
      .mockReset()
      .mockImplementation(() => ({ source, release: () => Promise.resolve() }));
  });

  it.each(["transient append", "persistent append", "voice close"])(
    "settles detached answer recovery (%s)",
    async (failureKind) => {
      const { session } = createRelaySession();
      session.voiceSessionCreated = true;

      const release = vi.fn(async () => {});
      captureWriter.mockReturnValue({
        options: { env: {} },
        source: { assertCurrent() {} },
        assertCurrent() {},
        release,
      });
      const failure = new Error("Answer append failed");
      const append = vi.fn().mockRejectedValue(failure);
      session.unspokenAnswers = new Map([["accepted-run", append]]);
      if (failureKind === "transient append") {
        append.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
      } else if (failureKind === "voice close") {
        append.mockResolvedValue(undefined);
        closeRecord.mockRejectedValue(failure);
      }
      try {
        const closing = closeRelayVoiceSession(session, "detach");
        if (failureKind === "transient append") {
          await expect(closing).resolves.toBeUndefined();
          expect(session.context.logGateway.warn).not.toHaveBeenCalled();
        } else {
          await expect(closing).rejects.toBe(failure);
          expect(session.context.logGateway.warn).toHaveBeenCalledWith(
            "realtime relay voice session close failed: Answer append failed",
          );
        }
        expect(append).toHaveBeenCalledTimes(
          failureKind === "transient append" ? 2 : failureKind === "persistent append" ? 3 : 1,
        );
        expect(closeRecord).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        session.unspokenAnswers.clear();
      }
    },
  );

  it.each([false, true])(
    "attempts later detached answers after a failure (later fails=%s)",
    async (laterFails) => {
      const { session } = createRelaySession();
      session.voiceSessionCreated = true;
      const firstError = new Error("First answer failed");
      const laterError = new Error("Later answer failed");
      const first = vi.fn().mockRejectedValue(firstError);
      const later = laterFails
        ? vi.fn().mockRejectedValue(laterError)
        : vi.fn().mockResolvedValue(undefined);
      session.unspokenAnswers = new Map([
        ["first", first],
        ["later", later],
      ]);

      const closing = closeRelayVoiceSession(session, "detach");
      if (laterFails) {
        await expect(closing).rejects.toMatchObject({ errors: [firstError, laterError] });
      } else {
        await expect(closing).rejects.toBe(firstError);
      }
      expect(first).toHaveBeenCalledTimes(3);
      expect(later).toHaveBeenCalledTimes(laterFails ? 3 : 1);
      expect(closeRecord).toHaveBeenCalledOnce();
    },
  );

  it("joins its accepted prefix after close settlement admission is lost", async () => {
    const lifecycle = await vi.importActual<
      typeof import("../../../talk/client-voice-session-lifecycle.js")
    >("../../../talk/client-voice-session-lifecycle.js");
    vi.mocked(withClientVoiceSessionSettlement).mockImplementation(
      lifecycle.withClientVoiceSessionSettlement,
    );
    await withOpenClawTestState({ scenario: "minimal", label: "relay-close-refusal" }, async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const append = createDeferred();
      const entered = createDeferred();
      appendTranscript.mockImplementation(async () => {
        entered.resolve();
        await append.promise;
      });
      const { session } = createRelaySession();
      const entryError = new Error("relay queue entry refused");
      const enqueue = vi
        .spyOn(session.voiceTranscriptQueue, "enqueue")
        .mockImplementationOnce(() => {
          throw entryError;
        });
      try {
        expect(enqueueRelayVoiceTranscript(session, "user", "not accepted")).toBe(false);
        await vi.advanceTimersByTimeAsync(0);
        expectWarning(session, entryError.message);
      } finally {
        enqueue.mockRestore();
      }
      expect(session.voiceTranscriptSeq).toBe(0);
      expect(enqueueRelayVoiceTranscript(session, "user", "accepted")).toBe(true);
      const accepted = captureClientVoiceSessionSettlement();
      const close = accepted.run(() =>
        AsyncLocalStorage.bind(() => closeRelayVoiceSession(session)),
      );
      accepted.release();
      const closing = close();
      let settled = false;
      void closing.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);
        expect(closeRecord).not.toHaveBeenCalled();
        append.resolve();
        await closing;
        expect(session.voiceTranscriptQueue.isIdle).toBe(true);
        expect(closeRecord).not.toHaveBeenCalled();
      } finally {
        append.resolve();
        await closing;
        vi.useRealTimers();
      }
    });
  });

  it.each([false, true])("retries only a known failed creation (unknown=%s)", async (unknown) => {
    const failure = unknown
      ? new SqliteWorkerError("Creation settlement is unknown", "outcome-unknown")
      : new Error("Creation was refused");
    createVoice.mockRejectedValueOnce(failure);
    const { session } = createRelaySession();
    expect(await ensureRelayVoiceSession(session)).toBe(false);
    expect(await ensureRelayVoiceSession(session)).toBe(!unknown);
    expect(createVoice).toHaveBeenCalledTimes(unknown ? 1 : 2);
  });

  it("does not replay an append after an unknown worker outcome", async () => {
    appendTranscript.mockRejectedValue(
      new SqliteWorkerError("Transcript settlement is unknown", "outcome-unknown"),
    );
    const { session } = createRelaySession();
    expect(enqueueRelayVoiceTranscript(session, "user", "Keep this accepted utterance")).toBe(true);
    await session.voiceTranscriptQueue.flush();
    await closeRelayVoiceSession(session);
    expect(appendTranscript).toHaveBeenCalledOnce();
    expectWarning(session, "Transcript settlement is unknown");
  });

  it("closes a voice created by a later accepted transcript after the first creation fails", async () => {
    const firstCreation = createDeferred<string>();
    createVoice.mockReturnValueOnce(firstCreation.promise);
    const { session } = createRelaySession();
    expect(enqueueRelayVoiceTranscript(session, "user", "First accepted utterance")).toBe(true);
    expect(enqueueRelayVoiceTranscript(session, "user", "Later accepted utterance")).toBe(true);
    const closing = closeRelayVoiceSession(session);
    firstCreation.reject(new Error("First creation was refused"));
    await closing;
    expect(createVoice).toHaveBeenCalledTimes(2);
    expect(appendTranscript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entryId: "2", text: "Later accepted utterance" }),
      expect.objectContaining({ release: expect.any(Function) }),
    );
    expect(session.voiceTranscriptQueue.isIdle).toBe(true);
    expect(closeRecord).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ voiceSessionId: session.id }),
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it.each([false, true])(
    "drains bounded finals before close settles (source refused=%s)",
    async (refuseCloseSource) => {
      const firstAppend = createDeferred();
      const appendEntered = createDeferred();
      appendTranscript.mockImplementation(async ({ entryId }: { entryId: string }) => {
        if (entryId === "1") {
          appendEntered.resolve();
          await firstAppend.promise;
        }
      });
      const { session, failSession } = createRelaySession(refuseCloseSource);
      const text = `  ${"x".repeat(9_000)}  `;
      let accepted = enqueueRelayVoiceTranscript(session, "user", text) ? 1 : 0;

      for (let index = 0; index < 10_000; index += 1) {
        expect(enqueueRelayVoiceTranscript(session, "user", " \t\n ")).toBe(true);
      }

      for (let index = 1; index < 10_000; index += 1) {
        if (enqueueRelayVoiceTranscript(session, index % 2 === 0 ? "user" : "assistant", text)) {
          accepted += 1;
        }
      }

      expect(accepted).toBe(41);
      await appendEntered.promise;
      expect(appendTranscript).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "main",
          sessionKey: "main",
          sessionTarget: {
            sessionKey: "agent:main:work",
            storePath: "/tmp/relay-voice-sessions.sqlite",
          },
        }),
        expect.objectContaining({ release: expect.any(Function) }),
      );
      expect(failSession).toHaveBeenCalledOnce();
      const close = session.voiceSessionClose;
      expect(close).toBeDefined();
      expect(closeRelayVoiceSession(session)).toBe(close);
      expect(closeRecord).not.toHaveBeenCalled();

      firstAppend.resolve();
      await close;

      expect(appendTranscript).toHaveBeenCalledTimes(41);
      expect(
        appendTranscript.mock.calls.map(([params]) => (params as { entryId: string }).entryId),
      ).toEqual(Array.from({ length: 41 }, (_, index) => String(index + 1)));
      expect(
        appendTranscript.mock.calls.every(
          ([params]) => (params as { text: string }).text.length === 8_000,
        ),
      ).toBe(true);
      expect(closeRecord).toHaveBeenCalledTimes(refuseCloseSource ? 0 : 1);
      if (refuseCloseSource) {
        expectWarning(session, "Voice source was replaced before close");
      }
      expect(enqueueRelayVoiceTranscript(session, "user", "too late")).toBe(false);
    },
  );
});
