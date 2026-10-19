import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { collectIncludePathsRecursive } from "./includes-scan.js";
import {
  CircularIncludeError,
  ConfigIncludeError,
  MAX_INCLUDE_DEPTH,
  type ConfigIncludeResolutionEvent,
  type IncludeResolver,
  resolveConfigIncludes,
} from "./includes.js";

const ROOT_DIR = path.parse(process.cwd()).root;
const CONFIG_DIR = path.join(ROOT_DIR, "config");
const ETC_OPENCLAW_DIR = path.join(ROOT_DIR, "etc", "openclaw");
const SHARED_DIR = path.join(ROOT_DIR, "shared");

const DEFAULT_BASE_PATH = path.join(CONFIG_DIR, "openclaw.json");

function configPath(...parts: string[]) {
  return path.join(CONFIG_DIR, ...parts);
}

function etcOpenClawPath(...parts: string[]) {
  return path.join(ETC_OPENCLAW_DIR, ...parts);
}

function createMockResolver(files: Record<string, unknown>): IncludeResolver {
  return {
    readFile: (filePath: string) => {
      if (filePath in files) {
        return JSON.stringify(files[filePath]);
      }
      throw new Error(`ENOENT: no such file: ${filePath}`);
    },
    parseJson: JSON.parse,
  };
}

function resolve(obj: unknown, files: Record<string, unknown> = {}, basePath = DEFAULT_BASE_PATH) {
  return resolveConfigIncludes(obj, basePath, createMockResolver(files));
}

async function writeFixture(filePath: string, content: unknown, raw = false) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw ? String(content) : JSON.stringify(content), "utf-8");
}

function includeChain(length: number) {
  return Object.fromEntries(
    Array.from({ length }, (_, i) => [
      configPath(`chain${i}.json`),
      i === length - 1 ? { done: true } : { $include: `./chain${i + 1}.json` },
    ]),
  );
}

function resolveWithEvents(obj: unknown, files: Record<string, unknown>) {
  const events: ConfigIncludeResolutionEvent[] = [];
  const resolver = createMockResolver(files);
  resolver.onIncludeResolved = (event) => events.push(event);
  return { result: resolveConfigIncludes(obj, DEFAULT_BASE_PATH, resolver), events };
}

function scan(configDir: string, parsed: unknown, allowedRoots?: string[]) {
  return collectIncludePathsRecursive({
    configPath: path.join(configDir, "openclaw.json"),
    parsed,
    allowedRoots,
  });
}

function expectResolveIncludeError(
  run: () => unknown,
  expectedPattern?: RegExp,
): ConfigIncludeError {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigIncludeError);
  if (expectedPattern) {
    expect((thrown as Error).message).toMatch(expectedPattern);
  }
  return thrown as ConfigIncludeError;
}

describe("resolveConfigIncludes", () => {
  it("projects archived includes before enforcing the existing root boundary", () => {
    const source = path.join(ROOT_DIR, "old-install", "database.json");
    const restored = configPath("captured", "database.json");
    const resolver = {
      ...createMockResolver({ [restored]: { database: { engine: "postgres" } } }),
      mapPath: () => restored,
    };
    expect(resolveConfigIncludes({ $include: source }, DEFAULT_BASE_PATH, resolver)).toEqual({
      database: { engine: "postgres" },
    });
    expectResolveIncludeError(
      () =>
        resolveConfigIncludes({ $include: source }, DEFAULT_BASE_PATH, {
          ...resolver,
          mapPath: () => source,
        }),
      /escapes config directory/,
    );
  });

  it("rejects sibling keys beside an array-valued include", () => {
    const files = { [configPath("list.json")]: ["a", "b"] };
    expectResolveIncludeError(
      () => resolve({ $include: "./list.json", extra: true }, files),
      /Sibling keys require included content to be an object/,
    );
  });

  it("reports exact include ownership through arrays, nesting, and sibling overrides", () => {
    const files = {
      [configPath("first.json")]: { id: "first" },
      [configPath("second.json")]: { enabled: true },
      [configPath("third.json")]: { mode: "strict" },
    };
    const { result, events } = resolveWithEvents(
      {
        plugins: [
          { $include: "./first.json" },
          {
            policy: {
              $include: ["./second.json", "./third.json"],
              enabled: false,
            },
          },
        ],
      },
      files,
    );
    expect(result).toEqual({
      plugins: [{ id: "first" }, { policy: { enabled: false, mode: "strict" } }],
    });
    expect(events).toEqual([
      {
        path: ["plugins", "0"],
        value: { id: "first" },
        kind: "single",
        hasSiblingOverrides: false,
        hasArrayAncestor: true,
        targetPath: configPath("first.json"),
      },
      {
        path: ["plugins", "1", "policy"],
        value: { enabled: true, mode: "strict" },
        kind: "multiple",
        hasSiblingOverrides: true,
        hasArrayAncestor: true,
        targetPaths: [configPath("second.json"), configPath("third.json")],
      },
    ]);
  });

  it("reports the enclosing include after nested delegates at the same logical path", () => {
    const files = {
      [configPath("delegating.json")]: { $include: "./nested.json" },
      [configPath("nested.json")]: { mode: "nested" },
      [configPath("override.json")]: { mode: "override" },
    };
    const { result, events } = resolveWithEvents(
      {
        agents: { $include: ["./delegating.json", "./override.json"] },
      },
      files,
    );
    expect(result).toEqual({ agents: { mode: "override" } });
    expect(
      events.map(({ path: logicalPath, kind, targetPath, targetPaths }) => ({
        path: logicalPath,
        kind,
        targetPath,
        targetPaths,
      })),
    ).toEqual([
      {
        path: ["agents"],
        kind: "single",
        targetPath: configPath("nested.json"),
        targetPaths: undefined,
      },
      {
        path: ["agents"],
        kind: "multiple",
        targetPath: undefined,
        targetPaths: [configPath("delegating.json"), configPath("override.json")],
      },
    ]);
  });

  it.each([
    {
      name: "read failures",
      run: () => resolve({ $include: "./missing.json" }),
      pattern: /Failed to read include file/,
    },
    {
      name: "parse failures",
      run: () =>
        resolveConfigIncludes({ $include: "./bad.json" }, DEFAULT_BASE_PATH, {
          readFile: () => "{ invalid json }",
          parseJson: JSON.parse,
        }),
      pattern: /Failed to parse include file/,
    },
  ] as const)("surfaces include $name", ({ run, pattern }) => {
    expectResolveIncludeError(run, pattern);
  });

  it("throws CircularIncludeError for circular includes", () => {
    const aPath = configPath("a.json"),
      bPath = configPath("b.json");
    const circular = expectResolveIncludeError(
      () =>
        resolve(
          { $include: "./a.json" },
          {
            [aPath]: { $include: "./b.json" },
            [bPath]: { $include: "./a.json" },
          },
        ),
      /Circular include detected/,
    );
    expect(circular).toBeInstanceOf(CircularIncludeError);
    expect(circular).toMatchObject({
      chain: expect.arrayContaining([DEFAULT_BASE_PATH, aPath, bPath]),
    });
    expect(circular.message).toContain("a.json");
    expect(circular.message).toContain("b.json");
  });

  it.each([
    {
      name: "rejects scalar include value",
      obj: { $include: 123 },
      expectedPattern: /expected string or array/,
    },
    {
      name: "rejects number in include array",
      obj: { $include: ["./valid.json", 123] },
      expectedPattern: /expected string, got number/,
    },
  ] as const)("throws on invalid include value/item types: $name", ({ obj, expectedPattern }) => {
    const files = { [configPath("valid.json")]: { valid: true } };
    expectResolveIncludeError(() => resolve(obj, files), expectedPattern);
  });

  it("allows depth 10 but rejects depth 11", () => {
    expect(resolve({ $include: "./chain0.json" }, includeChain(10))).toEqual({ done: true });
    expectResolveIncludeError(
      () => resolve({ $include: "./chain0.json" }, includeChain(11)),
      /Maximum include depth/,
    );
  });
});

describe("collectIncludePathsRecursive", () => {
  it.runIf(process.platform !== "win32")(
    "only reports includes the production resolver can safely open",
    async () => {
      await withTestDir({ prefix: "openclaw-include-scan-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const safeIncludePath = path.join(configDir, "safe.json5");
        const outsideIncludePath = path.join(tempRoot, "outside.json5");
        const symlinkPath = path.join(configDir, "outside-link.json5");
        await writeFixture(safeIncludePath, { safe: true });
        await writeFixture(outsideIncludePath, { outside: true });
        await fs.symlink(outsideIncludePath, symlinkPath);

        const includePaths = await scan(configDir, {
          $include: ["./safe.json5", "../outside.json5", "./outside-link.json5"],
        });

        expect(includePaths).toEqual([await fs.realpath(safeIncludePath)]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the original root boundary after a parent symlink swap",
    async () => {
      await withTestDir({ prefix: "openclaw-include-root-swap-" }, async (tempRoot) => {
        const trustedDir = path.join(tempRoot, "trusted");
        const outsideDir = path.join(tempRoot, "outside");
        const configLink = path.join(tempRoot, "config-link");
        await writeFixture(path.join(trustedDir, "outer.json5"), { $include: "./nested.json5" });
        await writeFixture(path.join(trustedDir, "nested.json5"), { trusted: true });
        await writeFixture(path.join(outsideDir, "nested.json5"), { escaped: true });
        await fs.symlink(trustedDir, configLink);

        let swapped = false;
        const resolver: IncludeResolver = {
          readFile: (filePath) => nodeFs.readFileSync(filePath, "utf-8"),
          parseJson: (raw) => {
            const parsed = JSON.parse(raw) as unknown;
            if (!swapped) {
              nodeFs.unlinkSync(configLink);
              nodeFs.symlinkSync(outsideDir, configLink);
              swapped = true;
            }
            return parsed;
          },
        };

        expect(() =>
          resolveConfigIncludes(
            { $include: "./outer.json5" },
            path.join(configLink, "openclaw.json"),
            resolver,
          ),
        ).toThrow(/resolves outside config directory/);
      });
    },
  );

  it("honors explicitly allowed include roots", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-roots-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const sharedDir = path.join(tempRoot, "shared");
      const sharedIncludePath = path.join(sharedDir, "shared.json5");
      await fs.mkdir(configDir, { recursive: true });
      await writeFixture(sharedIncludePath, "{ shared: true }\n", true);

      const includePaths = await scan(configDir, { $include: sharedIncludePath }, [sharedDir]);

      expect(includePaths).toEqual([await fs.realpath(sharedIncludePath)]);
    });
  });

  it("continues past rejected nested includes to later safe siblings", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-nested-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const outerIncludePath = path.join(configDir, "nested", "outer.json5");
      const safeIncludePath = path.join(configDir, "safe.json5");
      const escapedIncludePath = path.join(tempRoot, "escaped.json5");
      await writeFixture(outerIncludePath, { $include: ["../../escaped.json5", "../safe.json5"] });
      await writeFixture(safeIncludePath, { safe: true });
      await writeFixture(escapedIncludePath, { escaped: true });

      const includePaths = await scan(configDir, { $include: "./nested/outer.json5" });

      expect(includePaths).toEqual([
        await fs.realpath(outerIncludePath),
        await fs.realpath(safeIncludePath),
      ]);
    });
  });

  it("revisits an include reached later at a shallower depth", async () => {
    await withTestDir({ prefix: "openclaw-include-scan-depth-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const sharedIncludePath = path.join(configDir, "shared.json5");
      const leafIncludePath = path.join(configDir, "leaf.json5");
      for (let index = 0; index < MAX_INCLUDE_DEPTH - 1; index += 1) {
        const nextInclude =
          index === MAX_INCLUDE_DEPTH - 2 ? "./shared.json5" : `./chain-${index + 1}.json5`;
        await writeFixture(path.join(configDir, `chain-${index}.json5`), { $include: nextInclude });
      }
      await writeFixture(sharedIncludePath, { $include: "./leaf.json5" });
      await writeFixture(leafIncludePath, { leaf: true });

      const includePaths = await scan(configDir, {
        $include: ["./chain-0.json5", "./shared.json5"],
      });

      expect(includePaths).toContain(await fs.realpath(leafIncludePath));
    });
  });
});

describe("real-world config patterns", () => {
  it("supports per-client agent includes", () => {
    const agent = (id: string, workspace: string) => ({ id, workspace });
    const screenshot = agent("mueller-screenshot", "~/clients/mueller/screenshot");
    const transcribe = agent("mueller-transcribe", "~/clients/mueller/transcribe");
    const schmidt = agent("schmidt-screenshot", "~/clients/schmidt/screenshot");
    const files = {
      [configPath("clients", "mueller.json")]: {
        agents: [screenshot, transcribe],
        broadcast: { "group-mueller": ["mueller-screenshot", "mueller-transcribe"] },
      },
      [configPath("clients", "schmidt.json")]: {
        agents: [schmidt],
        broadcast: { "group-schmidt": ["schmidt-screenshot"] },
      },
    };
    expect(
      resolve(
        {
          gateway: { port: 18789 },
          $include: ["./clients/mueller.json", "./clients/schmidt.json"],
        },
        files,
      ),
    ).toEqual({
      gateway: { port: 18789 },
      agents: [screenshot, transcribe, schmidt],
      broadcast: {
        "group-mueller": ["mueller-screenshot", "mueller-transcribe"],
        "group-schmidt": ["schmidt-screenshot"],
      },
    });
  });
});
describe("security: path traversal protection (CWE-22)", () => {
  describe("prototype pollution protection", () => {
    it("blocks prototype pollution vectors in included and sibling config", () => {
      const includePath = configPath("pollution.json");
      const included = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":{"hidden":true},"normal":3}',
      ) as Record<string, unknown>;
      const sibling = JSON.parse('{"__proto__":{"alsoPolluted":true},"safe":1}') as Record<
        string,
        unknown
      >;

      const result = resolve(
        { $include: "./pollution.json", ...sibling },
        { [includePath]: included },
      );

      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
      expect((Object.prototype as Record<string, unknown>).alsoPolluted).toBeUndefined();
      expect(result).toEqual({ normal: 3, safe: 1 });
    });
  });

  describe("edge cases", () => {
    it("rejects malformed include paths", () => {
      const cases = [
        { includePath: "./file\x00.json", pattern: /null bytes?/i },
        { includePath: "//etc/passwd", pattern: /escapes config directory/ },
      ] as const;
      for (const testCase of cases) {
        const obj = { $include: testCase.includePath };
        expectResolveIncludeError(() => resolve(obj, {}), testCase.pattern);
      }
    });

    it("rejects include paths at or over the platform-safe maximum", () => {
      expectResolveIncludeError(
        () => resolve({ $include: "a".repeat(4096) }, {}),
        /maximum length/,
      );
    });

    it("fails closed when include realpath resolution fails for reasons other than ENOENT", () => {
      const includePath = configPath("denied.json");
      const originalRealpathSync = nodeFs.realpathSync;
      const realpathSpy = vi.spyOn(nodeFs, "realpathSync").mockImplementation((target) => {
        if (path.normalize(String(target)) === includePath) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return originalRealpathSync(target);
      });

      try {
        expectResolveIncludeError(
          () =>
            resolveConfigIncludes(
              { $include: "./denied.json" },
              DEFAULT_BASE_PATH,
              createMockResolver({ [includePath]: { leaked: true } }),
            ),
          /Failed to resolve include file realpath/,
        );
      } finally {
        realpathSpy.mockRestore();
      }
    });

    it("rejects include files that are hardlinked aliases", async () => {
      if (process.platform === "win32") {
        return;
      }
      await withTestDir({ prefix: "openclaw-includes-hardlink-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        const outsideDir = path.join(tempRoot, "outside");
        await fs.mkdir(configDir, { recursive: true });
        const includePath = path.join(configDir, "extra.json5");
        const outsidePath = path.join(outsideDir, "secret.json5");
        await writeFixture(outsidePath, { logging: { redactSensitive: "tools" } });
        try {
          await fs.link(outsidePath, includePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "EXDEV") {
            return;
          }
          throw err;
        }

        expect(() =>
          resolveConfigIncludes(
            { $include: "./extra.json5" },
            path.join(configDir, "openclaw.json"),
          ),
        ).toThrow(/security checks|hardlink/i);
      });
    });

    it("rejects include files larger than the guarded read limit", async () => {
      await withTestDir({ prefix: "openclaw-includes-big-" }, async (tempRoot) => {
        const configDir = path.join(tempRoot, "config");
        await writeFixture(path.join(configDir, "big.json5"), {
          blob: "a".repeat(2 * 1024 * 1024 + 1),
        });

        expect(() =>
          resolveConfigIncludes({ $include: "./big.json5" }, path.join(configDir, "openclaw.json")),
        ).toThrow(/security checks|max/i);
      });
    });
  });
});

describe("OPENCLAW_INCLUDE_ROOTS allowlist", () => {
  it("still rejects include paths that fall outside every allowed root", () => {
    const obj = { $include: etcOpenClawPath("agents.json") };
    expect(() =>
      resolveConfigIncludes(obj, DEFAULT_BASE_PATH, createMockResolver({}), {
        allowedRoots: [SHARED_DIR],
      }),
    ).toThrow(/escapes config directory/);
  });

  it("rejects a symlinked include that escapes both the config directory and every allowed root", async () => {
    await withTestDir({ prefix: "openclaw-includes-allowed-escape-" }, async (tempRoot) => {
      const configDir = path.join(tempRoot, "config");
      const allowedDir = path.join(tempRoot, "allowed");
      const offRootDir = path.join(tempRoot, "off-limits");
      await fs.mkdir(configDir, { recursive: true });
      await fs.mkdir(allowedDir, { recursive: true });
      const offRootTarget = path.join(offRootDir, "secret.json5");
      await writeFixture(offRootTarget, { leaked: true });
      const linkInConfig = path.join(configDir, "secret.json5");
      try {
        await fs.symlink(
          offRootTarget,
          linkInConfig,
          process.platform === "win32" ? "file" : undefined,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw err;
      }

      expect(() =>
        resolveConfigIncludes(
          { $include: "./secret.json5" },
          path.join(configDir, "openclaw.json"),
          undefined,
          { allowedRoots: [allowedDir] },
        ),
      ).toThrow(/resolves outside config directory/);
    });
  });
});
