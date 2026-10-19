import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureStdout,
  expectFields,
  firstRecord,
  jsonResponse,
  parseStdoutJson,
  requestUrl,
  setupCli,
  stubMeetArtifactsApi,
} from "./test-support/cli-harness.js";

async function runApiCommand(command: string, args: string[] = []) {
  const stdout = captureStdout();
  try {
    await setupCli({}).parseAsync(
      [
        "googlemeet",
        command,
        "--access-token",
        "token",
        "--expires-at",
        String(Date.now() + 120_000),
        ...args,
      ],
      { from: "user" },
    );
    return stdout;
  } finally {
    stdout.restore();
  }
}

function runRecordCommand(command: string, args: string[] = []) {
  return runApiCommand(command, ["--conference-record", "rec-1", ...args]);
}

const bundleFiles = [
  "summary.md",
  "attendance.csv",
  "transcript.md",
  "artifacts.json",
  "attendance.json",
  "manifest.json",
];

describe("google-meet CLI", () => {
  let tempDir: string;
  const readOutput = (name: string) => readFileSync(path.join(tempDir, name), "utf8");
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-artifacts-"));
    stubMeetArtifactsApi();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(`${tempDir}.zip`, { force: true });
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  it("prints artifacts and attendance output", async () => {
    const artifactsStdout = await runRecordCommand("artifacts", ["--json"]);
    const payload = parseStdoutJson(artifactsStdout);
    expectFields(payload, { tokenSource: "cached-access-token" });
    expectFields(firstRecord(payload.conferenceRecords), { name: "conferenceRecords/rec-1" });
    const artifact = firstRecord(payload.artifacts);
    expectFields(firstRecord(artifact.recordings), {
      name: "conferenceRecords/rec-1/recordings/r1",
    });
    expectFields(firstRecord(artifact.transcripts), {
      name: "conferenceRecords/rec-1/transcripts/t1",
    });
    const transcriptEntries = firstRecord(artifact.transcriptEntries);
    expectFields(transcriptEntries, { transcript: "conferenceRecords/rec-1/transcripts/t1" });
    expectFields(firstRecord(transcriptEntries.entries), { text: "Hello from the transcript." });
    expectFields(firstRecord(artifact.smartNotes), {
      name: "conferenceRecords/rec-1/smartNotes/sn1",
    });

    const attendanceStdout = await runRecordCommand("attendance");
    expect(attendanceStdout.output()).toContain("attendance rows: 1");
    expect(attendanceStdout.output()).toContain("participant: Alice");
    expect(attendanceStdout.output()).toContain(
      "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
    );
  });

  it("ends an active conference for a Meet space", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/v2/spaces/abc-defg-hij") {
        return jsonResponse({
          name: "spaces/space-resource-123",
          meetingCode: "abc-defg-hij",
          meetingUri: "https://meet.google.com/abc-defg-hij",
        });
      }
      if (url.pathname === "/v2/spaces/space-resource-123:endActiveConference") {
        return jsonResponse({});
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stdout = await runApiCommand("end-active-conference", [
      "https://meet.google.com/abc-defg-hij",
      "--json",
    ]);
    expectFields(parseStdoutJson(stdout), {
      space: "spaces/space-resource-123",
      ended: true,
      tokenSource: "cached-access-token",
    });
    const endCall = fetchMock.mock.calls.find(
      ([input]) =>
        input === "https://meet.googleapis.com/v2/spaces/space-resource-123:endActiveConference",
    );
    expect(endCall?.[1]).toEqual({
      method: "POST",
      body: "{}",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      },
    });
  });

  it("rejects access policy flags when create would use browser fallback", async () => {
    await expect(
      setupCli({
        runtime: {
          createViaBrowser: vi.fn(async () => {
            throw new Error("browser fallback should not run");
          }),
        },
      }).parseAsync(["googlemeet", "create", "--access-type", "OPEN"], { from: "user" }),
    ).rejects.toThrow("access policy options require OAuth/API room creation");
  });

  for (const { name, selectorArgs, expected } of [
    {
      name: "prints the latest conference record",
      selectorArgs: ["--meeting", "abc-defg-hij"],
      expected: "space: spaces/abc-defg-hij",
    },
    {
      name: "prints the latest conference record from today's calendar",
      selectorArgs: ["--today"],
      expected: "calendar event: Project sync",
    },
  ]) {
    it(name, async () => {
      const stdout = await runApiCommand("latest", selectorArgs);
      expect(stdout.output()).toContain(expected);
      expect(stdout.output()).toContain("conference record: conferenceRecords/rec-1");
    });
  }

  it("prints calendar event previews", async () => {
    const stdout = await runApiCommand("calendar-events", ["--today"]);
    expect(stdout.output()).toContain("meet events: 1");
    expect(stdout.output()).toContain("* Project sync");
    expect(stdout.output()).toContain("https://meet.google.com/abc-defg-hij");
  });

  it("rejects a fractional Meet API page size before fetching", async () => {
    const pageSize = "1.5";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      setupCli({}).parseAsync(
        [
          "googlemeet",
          "artifacts",
          "--access-token",
          "token",
          "--conference-record",
          "rec-1",
          "--page-size",
          pageSize,
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("page-size must be a positive integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints markdown artifact and attendance output", async () => {
    const outputPath = path.join(tempDir, "artifacts.md");

    const artifactsStdout = await runRecordCommand("artifacts", [
      "--format",
      "markdown",
      "--output",
      outputPath,
    ]);
    const markdown = readFileSync(outputPath, "utf8");
    expect(artifactsStdout.output()).toContain(`wrote: ${outputPath}`);
    expect(markdown).toContain("# Google Meet Artifacts");
    expect(markdown).toContain("## conferenceRecords/rec-1");
    expect(markdown).toContain("### Transcript Entries: conferenceRecords/rec-1/transcripts/t1");
    expect(markdown).toContain("Hello from the transcript.");

    const attendanceStdout = await runRecordCommand("attendance", ["--format", "markdown"]);
    expect(attendanceStdout.output()).toContain("# Google Meet Attendance");
    expect(attendanceStdout.output()).toContain("## Alice");
    expect(attendanceStdout.output()).toContain(
      "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves an existing output when the OS rejects a full write",
    () => {
      const outputPath = path.join(tempDir, "artifacts.md");
      const prior = "prior export\n";
      writeFileSync(outputPath, prior);
      chmodSync(outputPath, 0o640);

      const source = path.join(process.cwd(), "extensions/google-meet/src/cli-shared.ts");
      const script = `import { writeCliOutput } from ${JSON.stringify(source)}; await writeCliOutput({ output: process.env.OPENCLAW_TEST_OUTPUT }, "x".repeat(8192));`;
      const result = spawnSync(
        "/bin/sh",
        [
          "-c",
          'ulimit -f 1\nexec "$@"',
          "--",
          process.execPath,
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENCLAW_TEST_OUTPUT: outputPath },
          encoding: "utf8",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal === "SIGXFSZ" || result.stderr.includes("EFBIG")).toBe(true);
      expect(readFileSync(outputPath, "utf8")).toBe(prior);
      expect(statSync(outputPath).mode & 0o777).toBe(0o640);
      expect(readdirSync(tempDir)).toEqual(["artifacts.md"]);
    },
  );

  it("quotes carriage returns in formula-neutralized CSV cells", async () => {
    stubMeetArtifactsApi({ participantDisplayName: "\r=1+1" });
    const stdout = await runRecordCommand("attendance", ["--format", "csv"]);
    expect(stdout.output()).toContain('conferenceRecords/rec-1,"\'\r=1+1",users/alice');
  });

  it("writes an export bundle", async () => {
    const stdout = await runRecordCommand("export", [
      "--include-doc-bodies",
      "--zip",
      "--output",
      tempDir,
    ]);
    expect(stdout.output()).toContain(`export: ${tempDir}`);
    expect(readOutput("summary.md")).toContain("# Google Meet Artifacts");
    expect(readOutput("attendance.csv")).toContain("conferenceRecords/rec-1,Alice,users/alice");
    expect(readOutput("transcript.md")).toContain("Hello from the transcript.");
    expect(readOutput("transcript.md")).toContain("Transcript document body.");
    const manifest = JSON.parse(readOutput("manifest.json"));
    expectFields(manifest.request, {
      conferenceRecord: "rec-1",
      includeDocumentBodies: true,
    });
    expectFields(manifest, {
      tokenSource: "cached-access-token",
    });
    expectFields(manifest.counts, { attendanceRows: 1, warnings: 0 });
    expect(manifest.files).toEqual(bundleFiles);
    const artifacts = JSON.parse(readOutput("artifacts.json"));
    expectFields(firstRecord(artifacts.conferenceRecords), { name: "conferenceRecords/rec-1" });
    expectFields(firstRecord(firstRecord(artifacts.artifacts).transcripts), {
      documentText: "Transcript document body.",
    });
    const zip = await JSZip.loadAsync(readFileSync(`${tempDir}.zip`));
    expect(await zip.file("summary.md")?.async("string")).toContain("# Google Meet Artifacts");
  });

  it("includes artifact warnings in export summaries and manifests", async () => {
    stubMeetArtifactsApi({ failSmartNoteDocumentBody: true });

    await runRecordCommand("export", ["--include-doc-bodies", "--output", tempDir, "--json"]);
    const summary = readOutput("summary.md");
    expect(summary).toContain("### Warnings");
    expect(summary).toContain("Document body warning");
    const manifest = JSON.parse(readOutput("manifest.json"));
    expectFields(manifest.counts, { warnings: 1 });
    expectFields(firstRecord(manifest.warnings), {
      type: "smart_note_document_body",
      conferenceRecord: "conferenceRecords/rec-1",
      resource: "conferenceRecords/rec-1/smartNotes/sn1",
    });
  });

  it("prints a dry-run export manifest without writing files", async () => {
    const outputDir = path.join(tempDir, "bundle");

    const stdout = await runRecordCommand("export", [
      "--include-doc-bodies",
      "--output",
      outputDir,
      "--dry-run",
    ]);
    const payload = JSON.parse(stdout.output());
    expectFields(payload, {
      dryRun: true,
      tokenSource: "cached-access-token",
    });
    expectFields(payload.manifest.request, {
      conferenceRecord: "rec-1",
      includeDocumentBodies: true,
    });
    expectFields(payload.manifest.counts, {
      attendanceRows: 1,
      transcriptEntries: 1,
      warnings: 0,
    });
    expect(payload.manifest.files).toEqual(bundleFiles);
    expect(existsSync(outputDir)).toBe(false);
  });
  it("writes the artifact summary to --output", async () => {
    const outputPath = path.join(tempDir, "summary.txt");
    const summary = (await runRecordCommand("artifacts", ["--format", "summary"])).output();
    expect(summary).toContain("conference records: 1\n");
    expect(summary).toContain("token source: cached-access-token\n");
    const written = await runRecordCommand("artifacts", [
      "--format",
      "summary",
      "--output",
      outputPath,
    ]);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe(summary);
    expect(written.output()).toBe(`wrote: ${outputPath}\n`);
  });
});
