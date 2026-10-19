import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { assertPluginStateReadAvailable } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { defaultNativeSubagentMonitorRuntime } from "./native-subagent-monitor-runtime.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createLazyCodexAppServerBindingStore,
} from "./session-binding-store.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

it.each(["admission", "submissions", "assignments", "ready"] as const)(
  "joins a peer publication started during native monitor %s preparation",
  async (phase) => {
    const options = {
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempDir, "state") },
    };
    const state = createCodexSqliteTestBindingStateStore(options);
    const bindingStore = createLazyCodexAppServerBindingStore(state);
    const writer = createPluginStateKeyedStoreForTests<string>("codex", {
      ...options,
      namespace: phase === "submissions" ? options.namespace : "monitor-peer",
    });
    const warnings = vi.spyOn(embeddedAgentLog, "warn");
    let writing: Promise<void> | undefined;
    const beginPublication = () => {
      writing = writer.register("peer-session", "peer");
      // Real owner admission starts denial synchronously, before worker settlement.
      expect(() => assertPluginStateReadAvailable(state.asyncReads)).toThrow(
        "Plugin state authority is unavailable",
      );
    };
    if (phase === "ready") {
      const register = codexNativeSubagentMonitorRuntime.register;
      vi.spyOn(codexNativeSubagentMonitorRuntime, "register").mockImplementationOnce(
        async (params) => {
          const registration = await register(params);
          registration.ready = registration.ready.then(beginPublication);
          return registration;
        },
      );
    } else if (phase === "submissions") {
      const read = bindingStore.readNativeSubagentSubmissions.bind(bindingStore);
      vi.spyOn(bindingStore, "readNativeSubagentSubmissions").mockImplementationOnce(
        async (...args) => {
          const rows = await read(...args);
          beginPublication();
          return rows;
        },
      );
    } else if (phase === "assignments") {
      const read = bindingStore.readNativeSubagentAssignments!.bind(bindingStore);
      vi.spyOn(bindingStore, "readNativeSubagentAssignments").mockImplementationOnce(
        async (...args) => {
          const rows = await read(...args);
          beginPublication();
          return rows;
        },
      );
    }
    const harness = createStartedThreadHarness();
    const params = createParams(path.join(tempDir, "monitor-publication.jsonl"), tempDir);
    await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.json"), params.sessionId);
    const host = await createAdmittedHostCapabilityTestFixture(params, {
      gatewayContext: true,
      nativeModelPolicySupport: "exact",
    });
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      host.closeHost();
      host.closeAdmission();
      host.closeGateway();
    });
    params.hostCapabilities = host.hostCapabilities;
    params.agentHarnessCompletionScope = host.agentHarnessCompletionScope;
    const custody = await host.runWithGatewayScope(() =>
      defaultNativeSubagentMonitorRuntime.captureAgentHarnessCompletionCustody(
        host.agentHarnessCompletionScope!,
      ),
    );
    if (!custody) {
      throw new Error("Expected host-issued completion custody");
    }
    cleanup.defer(() => custody.release());
    expect(custody.isCurrent()).toBe(true);
    vi.spyOn(
      defaultNativeSubagentMonitorRuntime,
      "captureAgentHarnessCompletionCustody",
    ).mockImplementationOnce(async () => {
      const retained = custody.retain();
      if (phase === "admission") {
        beginPublication();
      }
      return retained;
    });
    const run = host.runWithGatewayScope(() => runCodexAppServerAttempt(params, { bindingStore }));
    try {
      await run.waitForTurnAccepted();
      expect(writing).toBeDefined();
      await writing;
      expect(await writer.lookup("peer-session")).toBe("peer");
      expect(
        warnings.mock.calls.filter(([message]) =>
          /Cannot recover native follow-up|Native pending assignments/.test(message),
        ),
      ).toEqual([]);
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    } finally {
      await writing;
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
  },
);
