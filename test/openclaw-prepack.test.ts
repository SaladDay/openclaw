// OpenClaw prepack tests validate package prepack output.
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { pnpmLockfileDocuments } from "../scripts/lib/pnpm-lockfile-documents.mjs";
import { restorePrepackArtifacts } from "../scripts/openclaw-postpack.mjs";
import {
  collectSourcePackWorkspaceDependencyErrors,
  resolvePrepackCommandStdio,
  runPrepackCommand,
} from "../scripts/openclaw-prepack.ts";
import { preparePackageDocsMap } from "../scripts/package-docs-map.mjs";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../src/infra/runtime-worker-url.js";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../src/shared/worker-bundle-hash.js";
import { resolveTestNodeExecPath } from "../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { toolingTsEntrypoints } from "./scripts/tooling-ts-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const testNodeExecPath = resolveTestNodeExecPath();
const validChannelEntry =
  'export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: "fixture-channel" }; } };\n';
const parentStore = "node_modules/.pnpm/fixture-parent@1.0.0/node_modules";
const read = (root: string, name: string) => readFileSync(path.join(root, name), "utf8");
function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const destination = path.join(root, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}
function run(
  command: string,
  args: string[],
  cwd: string,
  options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
) {
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    cwd,
    ...options,
  });
}
const rootPackageManager = (
  JSON.parse(readFileSync("package.json", "utf8")) as {
    packageManager: string;
  }
).packageManager;
const rootPnpmEnvironment = pnpmLockfileDocuments(
  readFileSync("pnpm-lock.yaml", "utf8"),
).environment;
if (!rootPnpmEnvironment) {
  throw new Error("pnpm-lock.yaml is missing its environment document");
}

const standaloneBundledChannelSmokeFiles = [
  "scripts/test-built-bundled-channel-entry-smoke.mts",
  "scripts/lib/build-smoke-env.mts",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "scripts/lib/bundled-plugin-paths.mjs",
  "scripts/lib/optional-bundled-clusters.mjs",
  "scripts/lib/package-root-args.mts",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/root-package-bundled-plugin-excludes.mjs",
  "scripts/process-warning-filter.mts",
  "src/shared/non-packaged-plugin-dirs.ts",
];

function linkFixtureParent(packageRoot: string) {
  const nodeModulesRoot = path.join(packageRoot, "node_modules");
  const parentRoot = path.join(packageRoot, parentStore, "fixture-parent");
  symlinkSync(
    process.platform === "win32" ? parentRoot : path.relative(nodeModulesRoot, parentRoot),
    path.join(nodeModulesRoot, "fixture-parent"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function createBundledChannelSmokeFixture(
  entrySource: string,
  options: { prepared?: boolean } = {},
) {
  const rootDir = tempDirs.make("openclaw-prepack-standalone-smoke-");
  for (const relativePath of standaloneBundledChannelSmokeFiles) {
    const destination = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(process.cwd(), relativePath), destination);
  }

  const packageRoot = options.prepared ? rootDir : path.join(rootDir, "package");
  const extensionRoot = path.join(packageRoot, "dist", "extensions", "fixture-channel");
  writeFiles(packageRoot, { "package.json": '{"files":[]}\n' });
  writeFiles(extensionRoot, {
    "package.json": `${JSON.stringify({
      name: "@openclaw/fixture-channel",
      openclaw: { channel: true, extensions: ["./index.ts"] },
    })}\n`,
    "index.js": entrySource,
  });
  const parentStoreRoot = path.join(packageRoot, parentStore);
  const parentRoot = path.join(parentStoreRoot, "fixture-parent");
  const siblingRoot = path.join(parentStoreRoot, "fixture-sibling");
  writeFiles(parentRoot, {
    "package.json":
      '{"name":"fixture-parent","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    "index.js": 'import { value } from "fixture-sibling"; export const fixtureValue = value;\n',
  });
  writeFiles(siblingRoot, {
    "package.json":
      '{"name":"fixture-sibling","version":"1.0.0","type":"module","exports":"./index.js"}\n',
    "index.js": 'export const value = "fixture-channel";\n',
  });
  linkFixtureParent(packageRoot);

  return {
    rootDir,
    packageRoot,
    dependencyFiles: {
      parent: read(parentRoot, "index.js"),
      sibling: read(siblingRoot, "index.js"),
    },
  };
}

function createPreparedPrepackFixture(entrySource: string) {
  const { rootDir } = createBundledChannelSmokeFixture(entrySource, { prepared: true });
  mkdirSync(path.join(rootDir, "node_modules"), { recursive: true });
  symlinkSync(
    path.dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
    path.join(rootDir, "node_modules/tsx"),
    "junction",
  );
  const workerSourceFiles = Object.fromEntries(
    WORKER_BUNDLE_ARTIFACT_PATHS.map((artifactPath) => [
      `dist/worker/${artifactPath}`,
      "export {};\n",
    ]),
  ) as Record<string, string>;
  const sourceFiles = {
    "package.json": '{"name":"openclaw","version":"2026.8.1","type":"module","files":["dist"]}\n',
    "CHANGELOG.md": "# Changelog\n\n## 2026.8.1\n- Current release notes with enough detail.\n",
    "docs/page.md": "# Package docs\n",
    "dist/index.js": "export {};\n",
    "dist/control-ui/index.html": "<!doctype html>\n",
    "dist/control-ui/assets/fixture.js.br": "prepared asset fixture\n",
    "dist/control-ui/assets/fixture.js.gz": "prepared asset fixture\n",
    ...workerSourceFiles,
  };
  writeFiles(rootDir, sourceFiles);
  return { rootDir, sourceFiles };
}

function createPrepackLifecycleFixture() {
  const { rootDir, sourceFiles } = createPreparedPrepackFixture(validChannelEntry);
  const packageJson = JSON.parse(sourceFiles["package.json"]);
  Object.assign(packageJson, {
    packageManager: rootPackageManager,
    files: [
      "dist",
      "!dist/worker/**",
      "dist/worker-artifacts/*.tar.gz",
      "docs/docs_map.md",
      "CHANGELOG.md",
      ".openclaw-lifecycle-pending",
    ],
    devDependencies: { "@openclaw/session-url-contract": "workspace:*" },
    scripts: {
      "build:package": "node rebuild.mjs",
      "update:compat:check": "node check-update-compat.mjs",
      prepack: "node lifecycle.mjs prepack",
      postpack: "node lifecycle.mjs postpack",
    },
  });
  sourceFiles["package.json"] = `${JSON.stringify(packageJson, null, 2)}\n`;
  sourceFiles["CHANGELOG.md"] += "\n## 2026.7.1\n- Previous release notes with enough detail.\n";
  // Without the toolchain lock, pnpm 12 resolves registry metadata before running prepack.
  writeFiles(rootDir, {
    "package.json": sourceFiles["package.json"],
    "pnpm-lock.yaml": `---\n${rootPnpmEnvironment}\n---\nlockfileVersion: '9.0'\nimporters: {}\n`,
    "CHANGELOG.md": sourceFiles["CHANGELOG.md"],
    "docs/docs_map.md": "Source docs-map stub.\n",
    "rebuild.mjs":
      'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync("build-invoked", "build:package\\n");\n' +
      'writeFileSync("dist/index.js", "export const rebuilt = true;\\n");\n',
    "check-update-compat.mjs":
      'import { writeFileSync } from "node:fs";\n' +
      'writeFileSync("compat-check-invoked", "update:compat:check\\n");\n',
    "lifecycle.mjs": `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const ownerArgs = process.argv[2] === "prepack"
  ? ${JSON.stringify(resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(toolingTsEntrypoints.prepack), testNodeExecPath))}
  : [${JSON.stringify(path.resolve("scripts/openclaw-postpack.mjs"))}];
const result = spawnSync(process.execPath, ownerArgs, { encoding: "utf8" });
writeFileSync(process.argv[2] + "-result.json", JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }));
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
`,
  });
  // pnpm may suppress lifecycle output; observe the actual hook before its reporter.
  const readLifecycleResult = (event: "prepack" | "postpack") =>
    JSON.parse(read(rootDir, `${event}-result.json`)) as {
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    };
  const packDir = path.join(rootDir, "pack");
  mkdirSync(packDir);
  const pack = () =>
    run("pnpm", ["pack", "--silent", "--pack-destination", packDir], rootDir, {
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
        OPENCLAW_PREPACK_PREPARED: "1",
      },
      timeout: 30_000,
    });
  return { rootDir, pack, readLifecycleResult };
}

function runStandaloneBundledChannelSmoke(entrySource: string) {
  const { dependencyFiles, rootDir, packageRoot } = createBundledChannelSmokeFixture(entrySource);
  const temporaryRoot = path.join(rootDir, "smoke-temp");
  mkdirSync(temporaryRoot);
  const sentinelPath = path.join(temporaryRoot, "unrelated.txt");
  writeFileSync(sentinelPath, "preserve caller-owned temporary sibling\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporaryRoot,
    TMP: temporaryRoot,
    TEMP: temporaryRoot,
  };
  delete env.OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT;

  const result = run(
    testNodeExecPath,
    [
      path.join(rootDir, "scripts", "test-built-bundled-channel-entry-smoke.mts"),
      "--package-root",
      packageRoot,
    ],
    rootDir,
    { env },
  );
  return {
    result,
    temporaryEntries: readdirSync(temporaryRoot).toSorted(),
    sentinel: read(temporaryRoot, "unrelated.txt"),
    entrySource: read(packageRoot, "dist/extensions/fixture-channel/index.js"),
    dependencyFiles: {
      parent: read(packageRoot, `${parentStore}/fixture-parent/index.js`),
      sibling: read(packageRoot, `${parentStore}/fixture-sibling/index.js`),
    },
    dependencyLink: {
      target: readlinkSync(path.join(packageRoot, "node_modules/fixture-parent")),
      resolved: realpathSync(path.join(packageRoot, "node_modules/fixture-parent")),
    },
    originalDependencyFiles: dependencyFiles,
  };
}

describe("standalone bundled channel smoke", () => {
  it("preserves the result and releases its layout for source with outcome=valid", () => {
    const entrySource = `
        import assert from "node:assert/strict";
        import { realpathSync } from "node:fs";
        import { fileURLToPath } from "node:url";
        import { fixtureValue } from "fixture-parent";
          const modulePath = realpathSync(fileURLToPath(import.meta.url)).replaceAll("\\\\", "/");
          assert.ok(modulePath.includes("/node_modules/openclaw/dist/"));
        export default { kind: "bundled-channel-entry", loadChannelPlugin() { return { id: fixtureValue }; } };
      `;
    const observed = runStandaloneBundledChannelSmoke(entrySource);
    const { result } = observed;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("channel=1");
    expect(result.stdout.match(/\[build-smoke\]/gu)).toHaveLength(1);
    expect(observed.entrySource).toBe(entrySource);
    expect(observed.dependencyFiles).toEqual(observed.originalDependencyFiles);
    expect(observed.dependencyLink.target).toContain(".pnpm");
    expect(observed.dependencyLink.resolved).toContain(
      path.join(".pnpm", "fixture-parent@1.0.0", "node_modules", "fixture-parent"),
    );
    expect(observed.sentinel).toBe("preserve caller-owned temporary sibling\n");
    expect(observed.temporaryEntries).toEqual(["unrelated.txt"]);
  });
});

describe("prepared prepack ownership", () => {
  it.each([false, true])(
    "does not mutate an incumbent docs map when smoke is invalid=%s",
    async (invalid) => {
      const { rootDir, sourceFiles } = createPreparedPrepackFixture(
        invalid ? "export default [];\n" : validChannelEntry,
      );
      await preparePackageDocsMap(rootDir);
      const receiptPath = path.join(rootDir, ".artifacts/package-docs-map/receipt.json");
      const receipt = readFileSync(receiptPath, "utf8");
      const ownerUrl = resolveRuntimeWorkerUrl(toolingTsEntrypoints.prepack);
      const result = run(
        testNodeExecPath,
        [
          ...resolveRuntimeWorkerArgv(ownerUrl, testNodeExecPath).slice(0, -1),
          "--input-type=module",
          "--eval",
          `import { preparePrepackArtifacts } from ${JSON.stringify(ownerUrl.href)}; await preparePrepackArtifacts();`,
        ],
        rootDir,
        {
          timeout: 30_000,
          env: {
            ...process.env,
            // The source smoke fixture retains the package's standalone loader contract.
            TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(invalid ? "AssertionError" : "PACKAGE_DOCS_MAP_ACTIVE");
      expect(existsSync(path.join(rootDir, ".openclaw-lifecycle-pending"))).toBe(false);
      expect(existsSync(path.join(rootDir, "dist/postinstall-inventory.json"))).toBe(false);
      for (const [name, contents] of Object.entries(sourceFiles)) {
        expect(readFileSync(path.join(rootDir, name), "utf8")).toBe(contents);
      }
      expect(readFileSync(receiptPath, "utf8")).toBe(receipt);
      await restorePrepackArtifacts(rootDir);
      expect(existsSync(receiptPath)).toBe(false);
    },
  );
});

describe("prepack lifecycle", () => {
  it("packs prepared packages without rebuilding or consulting live npm updater coverage", () => {
    const fixture = createPrepackLifecycleFixture();
    const result = fixture.pack();

    expect(result.error).toBeUndefined();
    expect(fixture.readLifecycleResult("prepack")).toMatchObject({ status: 0, signal: null });
    expect(existsSync(path.join(fixture.rootDir, "compat-check-invoked"))).toBe(false);
    expect(existsSync(path.join(fixture.rootDir, "build-invoked"))).toBe(false);
  });
});

describe("collectSourcePackWorkspaceDependencyErrors", () => {
  it("rejects the plain source pack that pnpm rewrites without bundling @openclaw/ai", () => {
    const rootDir = tempDirs.make("openclaw-source-pack-workspace-");
    const aiDir = path.join(rootDir, "packages", "ai");
    const packDir = path.join(rootDir, "pack");
    const extractDir = path.join(rootDir, "extract");
    const version = "2099.1.2-test.0";
    const rootPackageJson = {
      dependencies: { "@openclaw/ai": "workspace:*" },
      name: "openclaw-source-pack-regression",
      packageManager: rootPackageManager,
      version,
    };
    mkdirSync(packDir);
    mkdirSync(extractDir);
    writeFiles(rootDir, {
      "package.json": `${JSON.stringify(rootPackageJson, null, 2)}\n`,
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/ai/package.json": `${JSON.stringify({ name: "@openclaw/ai", version }, null, 2)}\n`,
    });

    const install = run("pnpm", ["install", "--ignore-scripts", "--reporter=silent"], rootDir);
    expect(install.status, install.stderr).toBe(0);
    const packed = run(
      "pnpm",
      ["pack", "--config.ignore-scripts=true", "--json", "--pack-destination", packDir],
      rootDir,
    );
    expect(packed.status, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as
      | { filename: string }
      | Array<{
          filename: string;
        }>;
    const filename = Array.isArray(packResult) ? packResult[0]?.filename : packResult.filename;
    expect(filename).toBeTruthy();
    const tarballPath = path.resolve(packDir, path.basename(filename ?? ""));
    tar.x({ cwd: extractDir, file: tarballPath, sync: true });

    const packedPackageJson = JSON.parse(
      readFileSync(path.join(extractDir, "package", "package.json"), "utf8"),
    ) as {
      bundleDependencies?: string[];
      dependencies?: Record<string, string>;
    };
    expect(packedPackageJson.dependencies?.["@openclaw/ai"]).toBe(version);
    expect(packedPackageJson.bundleDependencies).toBeUndefined();
    expect(existsSync(path.join(extractDir, "package", "node_modules", "@openclaw", "ai"))).toBe(
      false,
    );
    expect(existsSync(path.join(extractDir, "package", "npm-shrinkwrap.json"))).toBe(false);
    expect(existsSync(path.join(extractDir, "package", "package-lock.json"))).toBe(false);
    expect(collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {})).toEqual([
      "plain root packing cannot safely resolve @openclaw/ai from workspace:*: pnpm rewrites the workspace dependency to an exact version without bundling the package",
      "use `node scripts/package-openclaw-for-docker.mjs --allow-unreleased-changelog` for a self-contained source package; official npm release automation prepares and publishes @openclaw/ai separately",
    ]);
    expect(
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        OPENCLAW_PREPACK_PREPARED: "1",
      }),
    ).toEqual([]);
    const workspaceErrors = (overrides: NodeJS.ProcessEnv = {}) =>
      collectSourcePackWorkspaceDependencyErrors(rootPackageJson, {
        npm_command: "pack",
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "ocm-npm-workspace-deps.mts"),
        OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: aiDir,
        ...overrides,
      });
    expect(workspaceErrors()).toEqual([]);
    expect(workspaceErrors({ OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS: rootDir })).toHaveLength(2);
    expect(
      workspaceErrors({
        OCM_INTERNAL_NPM_BIN: path.join(rootDir, "scripts", "other-npm-wrapper.mjs"),
      }),
    ).toHaveLength(2);
    expect(workspaceErrors({ npm_command: "publish" })).toHaveLength(2);
  });
});

describe("runPrepackCommand", () => {
  it("keeps prepack child stdout off npm pack JSON stdout", () => {
    expect(resolvePrepackCommandStdio({ stdio: "inherit" }, { npm_config_json: "true" })).toEqual([
      "inherit",
      2,
      "inherit",
    ]);
    expect(
      resolvePrepackCommandStdio(
        { stdio: ["ignore", "pipe", "pipe"] },
        { npm_config_json: "true" },
      ),
    ).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("bounds commands that ignore termination", () => {
    const startedAt = Date.now();
    const result = runPrepackCommand(
      testNodeExecPath,
      ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 100,
      },
    );

    expect(result.error).toBeInstanceOf(Error);
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });
});
