import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import { loadTelegramUserbotSkillRuntime } from "./userbot-skill.runtime.js";

const tempRoots: string[] = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-userbot-runtime-test-"));
  tempRoots.push(root);
  return root;
}

function writeDriver(lines: string[], root = tempRoot()) {
  const scriptPath = path.join(root, "user-driver.py");
  fs.writeFileSync(
    scriptPath,
    [
      "import json",
      "import sys",
      "print(json.dumps({'type':'ready','chatId':-1001,'user':{'id':100}}), flush=True)",
      ...lines,
    ].join("\n"),
  );
  return scriptPath;
}

function startDriver(
  userDriverPath: string,
  options: Partial<Parameters<typeof TelegramUserbotDriver.start>[0]> = {},
) {
  return TelegramUserbotDriver.start({
    chatId: "-1001",
    driverEnv: {},
    leaseHealth: { assertHealthy() {}, whenUnhealthy: new Promise<Error>(() => {}) },
    onUpdate() {},
    ...options,
    userDriverPath,
  });
}

const entity = (offset: number, length: number, type = "textEntityTypeCode") => ({
  offset,
  length,
  type: { "@type": type },
});

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Telegram userbot driver runtime", () => {
  it("keeps one process for commands and streamed formatting edits", async () => {
    const text = "😀 a   b x";
    const entities = [
      entity(3, 5),
      {
        offset: 9,
        length: 1,
        type: { "@type": "textEntityTypeTextUrl", url: "https://example.com/qa" },
      },
    ];
    const editedEntities = [entity(3, 5, "textEntityTypeBold")];
    const richMessage = {
      "@type": "richMessage",
      is_full: true,
      is_rtl: false,
      blocks: [
        {
          "@type": "pageBlockParagraph",
          text: {
            "@type": "richTextUrl",
            url: "https://example.com/qa",
            text: { "@type": "richTextMathematicalExpression", expression: "x" },
          },
        },
      ],
    };
    const scriptPath = writeDriver([
      `entities = json.loads(${JSON.stringify(JSON.stringify(entities))})`,
      `edited_entities = json.loads(${JSON.stringify(JSON.stringify(editedEntities))})`,
      `rich_message = json.loads(${JSON.stringify(JSON.stringify(richMessage))})`,
      "for line in sys.stdin:",
      "    request = json.loads(line)",
      "    assert request['chatId'] == '-2002' and request['forumTopicId'] == 42",
      "    message_id = 10 + int(request['id'])",
      "    update = {'kind':'message','chatId':-1001,'messageId':message_id + 1,'senderId':200,'timestamp':1000,'text':request['text'],'entities':entities,'contentType':'messagePhoto'}",
      "    print(json.dumps({'type':'update','update':update}), flush=True)",
      "    for replacement in [edited_entities, []]:",
      "        update = {**update, 'kind':'edit', 'entities':replacement, 'contentType':'messageVideo'}",
      "        print(json.dumps({'type':'update','update':update}), flush=True)",
      "    for rich in [rich_message, {**rich_message, 'is_full':False}, None]:",
      "        update = {**update, 'richMessage':rich, 'text':'x', 'entities':[], 'contentType':'messageRichMessage' if rich else 'messageText'}",
      "        print(json.dumps({'type':'update','update':update}), flush=True)",
      "    result = {'chatId':-1001,'messageId':message_id,'senderId':100,'timestamp':1000,'text':request['text'],'entities':entities,'contentType':'messageText','forumTopicId':request['forumTopicId']}",
      "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
    ]);
    const updates: TelegramUserbotUpdate[] = [];
    const driver = await startDriver(scriptPath, {
      expectedUserId: "100",
      onUpdate(update) {
        updates.push(update);
      },
    });
    try {
      await expect(driver.send({ text, chatId: "-2002", forumTopicId: 42 })).resolves.toMatchObject(
        {
          forumTopicId: 42,
          messageId: 11,
          senderId: 100,
          contentType: "messageText",
          text,
          entities,
        },
      );
      await vi.waitFor(() => expect(updates).toHaveLength(6));
      const edit = { kind: "edit", messageId: 12, contentType: "messageVideo", text };
      const richEdit = { kind: "edit", messageId: 12, contentType: "messageRichMessage" };
      expect(updates).toMatchObject([
        {
          kind: "message",
          messageId: 12,
          senderId: 200,
          contentType: "messagePhoto",
          text,
          entities,
        },
        { ...edit, entities: editedEntities },
        { ...edit, entities: [] },
        { ...richEdit, richMessage },
        { ...richEdit, richMessage: { ...richMessage, is_full: false } },
        { kind: "edit", messageId: 12, contentType: "messageText", text: "x", entities: [] },
      ]);
      expect(updates[5]).not.toHaveProperty("richMessage");
      expect(() => driver.assertHealthy()).not.toThrow();
    } finally {
      await driver.close();
    }
  });

  it.each([
    { name: "missing entities", entities: undefined, streamed: false },
    { name: "non-array entities", entities: {}, streamed: false },
    { name: "non-object entity", entities: [null], streamed: false },
    { name: "negative offset", entities: [entity(-1, 1)], streamed: false },
    { name: "fractional length", entities: [entity(3, 1.5)], streamed: false },
    { name: "empty range", entities: [entity(3, 0)], streamed: false },
    { name: "range past the text", entities: [entity(3, 8)], streamed: true },
    { name: "start inside a surrogate pair", entities: [entity(1, 1)], streamed: true },
    { name: "end inside a surrogate pair", entities: [entity(0, 1)], streamed: false },
    {
      name: "missing entity type",
      entities: [{ offset: 3, length: 1, type: {} }],
      streamed: true,
    },
  ])("rejects $name at the child protocol boundary", async ({ entities, streamed }) => {
    const message = {
      chatId: -1001,
      messageId: 11,
      senderId: 100,
      timestamp: 1000,
      text: "😀 a   b x",
      entities,
    };
    const scriptPath = writeDriver([
      `result = json.loads(${JSON.stringify(JSON.stringify(message))})`,
      "for line in sys.stdin:",
      "    request = json.loads(line)",
      ...(streamed
        ? [
            "    print(json.dumps({'type':'update','update':{**result, 'kind':'message'}}), flush=True)",
            "    result = {**result, 'entities':[]}",
          ]
        : []),
      "    print(json.dumps({'type':'response','id':request['id'],'result':result}), flush=True)",
    ]);
    const onUpdate = vi.fn();
    const driver = await startDriver(scriptPath, { onUpdate });
    try {
      await expect(driver.send({ text: message.text })).rejects.toThrow(/invalid entit/u);
      expect(onUpdate).not.toHaveBeenCalled();
    } finally {
      await driver.close();
    }
  });

  it("stops a delayed TDLib send before its final effect after lease loss", async () => {
    const root = tempRoot();
    const markerPath = path.join(root, "sent.txt");
    const scriptPath = writeDriver(
      [
        "import pathlib",
        "import time",
        "for line in sys.stdin:",
        "    request = json.loads(line)",
        "    time.sleep(1)",
        `    pathlib.Path(${JSON.stringify(markerPath)}).write_text('sent')`,
      ],
      root,
    );
    let revoke: (error: Error) => void = () => {};
    const whenUnhealthy = new Promise<Error>((resolve) => {
      revoke = resolve;
    });
    const driver = await startDriver(scriptPath, {
      leaseHealth: { assertHealthy() {}, whenUnhealthy },
    });

    const sending = driver.send({ text: "must not send" });
    revoke(new Error("lease revoked"));

    await expect(sending).rejects.toThrow("lease revoked");
    await new Promise((resolve) => {
      setTimeout(resolve, 1_100);
    });
    expect(fs.existsSync(markerPath)).toBe(false);
    await driver.close();
  });

  it("loads the selected repository skill from a different working directory", async () => {
    const repoRoot = tempRoot();
    const skillPath = path.join(repoRoot, ".agents", "skills", "telegram-e2e-userbot");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.cpSync(path.join(process.cwd(), ".agents", "skills", "telegram-e2e-userbot"), skillPath, {
      recursive: true,
    });
    // The selected skill imports the shared credential bootstrap at its repository-relative path.
    const bootstrapPath = path.join("extensions", "qa-lab", "src", "qa-credentials-bootstrap.ts");
    fs.mkdirSync(path.dirname(path.join(repoRoot, bootstrapPath)), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), bootstrapPath), path.join(repoRoot, bootstrapPath));
    const runtime = await loadTelegramUserbotSkillRuntime({ repoRoot, env: {} });

    expect(runtime.userDriverPath).toBe(
      path.join(repoRoot, ".agents", "skills", "telegram-e2e-userbot", "scripts", "user-driver.py"),
    );
    expect(() => runtime.parseCredential({})).toThrow("unsupported schema or environment");
    const stateRoot = runtime.createStateRoot();
    expect(fs.statSync(stateRoot).isDirectory()).toBe(true);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
});
