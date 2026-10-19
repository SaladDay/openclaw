import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { assertNoGatewayLogSentinels } from "./gateway-log-sentinel.js";
import { readQaScenarioById, readQaScenarioPackYamlSource } from "./scenario-catalog.js";
import { readFlowAssertExpression, requireFlowScenario } from "./scenario-catalog.test-utils.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { createRestartFlowFixture } from "./scenario-restart-flow.test-support.js";

function matchesAction(action: unknown, fields: { call?: string; saveAs?: string; set?: string }) {
  return (
    typeof action === "object" &&
    action !== null &&
    Object.entries(fields).every(([key, value]) => Reflect.get(action, key) === value)
  );
}

function callIndex(actions: unknown[], call: string, saveAs?: string) {
  return actions.findIndex((action) =>
    matchesAction(action, { call, ...(saveAs ? { saveAs } : {}) }),
  );
}

function assertionIndex(actions: unknown[], ...needles: string[]) {
  return actions.findIndex((action) =>
    needles.every((needle) => readFlowAssertExpression(action).includes(needle)),
  );
}

function lambdaExpression(action: unknown) {
  const call = action as { args?: { lambda?: { expr?: string } }[] } | undefined;
  return call?.args?.[0]?.lambda?.expr ?? "";
}

function flowFixture(id: string, step = 0) {
  const scenario = requireFlowScenario(readQaScenarioById(id));
  return { scenario, actions: scenario.execution.flow?.steps[step]?.actions ?? [] };
}

function expectInOrder(first: number, ...indices: number[]) {
  expect(first).toBeGreaterThanOrEqual(0);
  let previous = first;
  for (const index of indices) {
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function expectContains(text: string, ...needles: string[]) {
  for (const needle of needles) {
    expect(text).toContain(needle);
  }
}

function runActions(
  scenarioId: string,
  actions: unknown[],
  options: Omit<NonNullable<Parameters<typeof runLoadedScenarioFlow>[1]>, "flow"> = {},
) {
  return runLoadedScenarioFlow(scenarioId, {
    ...options,
    flow: { steps: [{ name: "checks loaded scenario actions", actions }] },
  });
}

describe("qa scenario catalog causality", () => {
  it("treats denied Telegram admission as silent transport suppression", () => {
    for (const scenarioId of [
      "telegram-policy-hot-reload",
      "telegram-group-policy-hot-reload",
      "telegram-repeated-command-authorization",
    ]) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const flow = JSON.stringify(scenario.execution.flow);
      expect(flow).toContain("waitForNoOutbound");
      expect(flow).not.toContain("not authorized");
    }
  });

  it("never slices bounded gateway log snapshots with absolute cursors", () => {
    expect(readQaScenarioPackYamlSource()).not.toMatch(
      /readGatewayLogs\s*\(\s*\)[^\r\n]*\.slice\s*\(/u,
    );
  });

  it("binds live restart checkpoints to persisted ingress and exactly one final delivery", () => {
    const liveMultiRestart = requireFlowScenario(readQaScenarioById("gateway-restart-multi-live"));
    const liveMultiRestartFlow = liveMultiRestart.execution.flow;
    const liveMultiRestartContract = JSON.stringify(liveMultiRestartFlow);
    const liveMultiRestartPrompt =
      typeof liveMultiRestart.execution.config?.prompt === "string"
        ? liveMultiRestart.execution.config.prompt
        : "";
    const liveMultiRestartActions = liveMultiRestartFlow?.steps[1]?.actions ?? [];
    const checkpointLoop = liveMultiRestartActions.find(
      (action): action is { forEach?: { actions?: unknown[] } } =>
        typeof action === "object" && action !== null && "forEach" in action,
    );
    const checkpointActions = checkpointLoop?.forEach?.actions ?? [];
    const checkpointPersistenceAssertIndex = assertionIndex(
      checkpointActions,
      "checkpointEntry",
      "checkpointTranscript.userMessageCount >= 1",
      "checkpointTranscript.eventCursor > 0",
      "checkpointTranscript.probeTextEndLine ?? 0",
      "restartRecoveryDeliveryContext?.channel === 'qa-channel'",
      "restartRecoveryDeliveryContext.to === `dm:${conversationId}`",
    );
    const outboundCountIndex = liveMultiRestartActions.findIndex((action) =>
      matchesAction(action, { set: "outboundCountAfterDelivery" }),
    );
    const quietWindowIndex = liveMultiRestartActions.findIndex(
      (action) => typeof action === "object" && action !== null && "waitForNoOutbound" in action,
    );
    const finalCardinalityAssertIndex = assertionIndex(
      liveMultiRestartActions,
      "finalMatches.length === 1",
    );
    expect(liveMultiRestart).toMatchObject({
      execution: { retryCount: 0, runtime: "openclaw" },
      runtimePairLane: undefined,
      gatewayConfigPatch: { tools: { alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"] } },
    });
    expectContains(
      liveMultiRestartPrompt,
      "restart-audit/components.md",
      "restart-audit/risks.md",
      "restart-audit/deployments.md",
      "restart-audit/controls.md",
      "restart-audit/recommendation.md",
      "On this original user turn, perform only checkpoint 1",
      "After the third Gateway-recovery system message, perform the audit and final report",
      "make exactly one `exec` call with `restartSafe: true`",
      "expired, or aborted `wait` result after restart is expected",
      "Do not issue another `exec` until a new Gateway-recovery system message arrives",
      '.some(candidate => candidate.toolName === "qa_restart_unsafe_probe")',
      "Do not read the `restart-audit/` directory path",
    );
    expectContains(
      liveMultiRestartContract,
      "pendingCodeModeExecNeedle",
      "summary.hasPendingCodeModeWait",
      "checkpoint",
      "restarts=3",
      "sendInbound",
      "id: `dm:${conversationId}`",
      "dmScope: env.cfg.session?.dmScope",
      '"saveAs":"inbound"',
      "probeText: config.finalMarker",
      "pendingCodeModeExecNeedle: `CHECKPOINT-${checkpoint}`",
      "dispatching restart-safe recovery",
    );
    expect(liveMultiRestartContract).not.toContain("startAgentRun");
    expect(liveMultiRestartContract).not.toContain(
      "assistantToolCallCounts.wait ?? 0) > (summary.completedToolCallCounts.wait ?? 0)",
    );
    expectInOrder(
      callIndex(checkpointActions, "waitForCondition", "checkpointTranscript"),
      callIndex(checkpointActions, "readRawQaSessionStore", "checkpointStore"),
      checkpointPersistenceAssertIndex,
      callIndex(checkpointActions, "restartGatewayWithConfigPatch"),
    );
    expectInOrder(
      callIndex(liveMultiRestartActions, "waitForOutboundMessage", "outbound"),
      outboundCountIndex,
      quietWindowIndex,
      finalCardinalityAssertIndex,
    );
    expect(liveMultiRestartActions[quietWindowIndex]).toMatchObject({
      waitForNoOutbound: {
        quietMs: 3000,
        sinceIndex: { ref: "outboundCountAfterDelivery" },
      },
    });
    expect(callIndex(liveMultiRestartActions, "sleep")).toBe(-1);
  });

  it("rejects an unrelated pending wait at the current restart checkpoint", async () => {
    const { actions } = flowFixture("gateway-restart-inflight-run");
    const checkpointLoop = actions.find(
      (action): action is { forEach: { actions: unknown[] } } =>
        typeof action === "object" && action !== null && "forEach" in action,
    );
    const pendingWait = checkpointLoop?.forEach.actions.find((action) =>
      matchesAction(action, { call: "waitForCondition", saveAs: "checkpointTranscript" }),
    );
    if (!pendingWait) {
      throw new Error("restart scenario checkpoint wait is missing");
    }
    const observations: unknown[] = [];
    const result = runActions(
      "gateway-restart-inflight-run",
      [
        { set: "checkpoint", value: { expr: "2" } },
        { set: "sessionKey", value: "agent:qa:checkpoint" },
        pendingWait,
      ],
      {
        api: {
          readSessionTranscriptSummary: async (
            _env: unknown,
            _sessionKey: string,
            options: unknown,
          ) => {
            observations.push(options);
            // Aggregate counts can include an unrelated pending wait after checkpoint 1.
            return {
              assistantToolCallCounts: { exec: 2, wait: 2 },
              completedToolCallCounts: { wait: 1 },
              hasPendingCodeModeWait: false,
            };
          },
        },
      },
    );
    await expect(result).rejects.toThrow("test condition was not met");
    expect(observations.length).toBeGreaterThan(0);
    for (const options of observations) {
      expect(options).toMatchObject({ pendingCodeModeExecNeedle: "CHECKPOINT-2" });
    }
  });

  it("runs one persisted inbound through three distinct restart lifecycles and quiet delivery", async () => {
    const scenario = requireFlowScenario(readQaScenarioById("gateway-restart-inflight-run"));
    // These settings are applied by the suite launcher, outside the flow interpreter.
    // In particular, the unsafe probe must start available for its later absence to prove fencing.
    expect(scenario.execution).toMatchObject({ retryCount: 0, suiteIsolation: "isolated" });
    expect(scenario.gatewayConfigPatch).toMatchObject({
      logging: { audit: { executionIdentity: true } },
      plugins: {
        slots: { memory: "none" },
        entries: { acpx: { enabled: false }, "memory-core": { enabled: false } },
      },
      tools: { alsoAllow: ["qa_restart_wait", "qa_restart_unsafe_probe"] },
    });
    const fixture = createRestartFlowFixture();
    await expect(fixture.run()).resolves.toMatchObject({ status: "pass" });
    const { events, auditRunIds, restartOrigins } = fixture;
    expect({ events, auditRunIds, restartOrigins }).toEqual({
      events: [
        "inbound",
        ...[1, 2, 3].flatMap((n) => [`pending:CHECKPOINT-${n}`, `persisted:${n}`, `restart:${n}`]),
        "delivery",
        "quiet:3000:1",
      ],
      auditRunIds: ["delivery-1", "delivery-1"],
      restartOrigins: [64001, 64002, 64003].map((port) => [`http://127.0.0.1:${port}`]),
    });
  });

  it.each([
    ["missing delivery claim", "did not persist the one original prompt", 0],
    ["stale lifecycle", "did not rotate the accepted delivery run/lifecycle fence", 2],
    ["stale delivery owner", "did not rotate the accepted delivery run/lifecycle fence", 2],
    ["changed audit identity", "original admitted audit identity changed", 3],
    ["duplicate delivery", "expected exactly one automatically recovered marker", 3],
    ["extra inbound", "expected one real qa-channel inbound turn", 3],
    ["late delivery", "unexpected outbound during quiet window", 3],
  ] as const)("rejects %s in the loaded three-restart flow", async (fault, message, restarts) => {
    const fixture = createRestartFlowFixture(fault);
    await expect(fixture.run()).rejects.toThrow(message);
    expect(fixture.restartOrigins).toHaveLength(restarts);
  });

  it("keeps full-access restart delivery independent from subagent completion handoff", async () => {
    const { scenario, actions } = flowFixture("gateway-restart-full-access-live", 1);
    const prompt =
      typeof scenario.execution.config?.prompt === "string" ? scenario.execution.config.prompt : "";
    const childIndex = callIndex(actions, "waitForCondition", "childRun");
    const childExpr = lambdaExpression(actions[childIndex]);

    expectContains(
      prompt,
      "expectsCompletionMessage false",
      "do not call sessions_yield or wait for the child",
    );
    expectContains(
      childExpr,
      "run.execution.status === 'terminal'",
      "run.execution.outcome?.status === 'ok'",
      "run.delivery?.status === 'not_required'",
    );
    expect(childExpr).not.toContain("terminalOutcome");
    expectInOrder(callIndex(actions, "waitForOutboundMessage", "outbound"), childIndex);

    const childAssertionPath = actions.slice(childIndex, childIndex + 3);
    await expect(
      runActions(
        "gateway-restart-full-access-live",
        [{ set: "sessionKey", value: "agent:qa:restart-proof" }, ...childAssertionPath],
        {
          api: {
            readNativeQaSubagentRuns: async () => [
              {
                runId: "restart-proof-child-run",
                label: "restart-proof-child",
                requesterSessionKey: "agent:qa:restart-proof",
                childSessionKey: "agent:qa:restart-proof:child",
                execution: { status: "terminal", outcome: { status: "ok" } },
                delivery: { status: "not_required" },
              },
            ],
            readSessionTranscriptSummary: async () => ({ finalText: "CHILD-RESTART-OK" }),
          },
        },
      ),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it.each(["gateway-restart-inflight-run", "gateway-restart-multi-live"] as const)(
    "ignores pre-scenario gateway sentinel logs during %s recovery",
    async (scenarioId) => {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      const actions = scenario.execution.flow?.steps.flatMap((step) => step.actions) ?? [];
      const gatewayActions = actions.filter(
        (action) =>
          (action as { set?: string }).set === "gatewayLogCursor" ||
          (action as { call?: string }).call === "assertNoGatewayLogSentinels",
      );
      expect(gatewayActions).toHaveLength(2);
      const priorLogs = "codex_app_server progress stalled before this scenario\n";

      await expect(
        runActions(scenarioId, gatewayActions, {
          api: {
            markGatewayLogCursor: () => priorLogs.length,
            assertNoGatewayLogSentinels: (
              options?: Parameters<typeof assertNoGatewayLogSentinels>[1],
            ) => assertNoGatewayLogSentinels(`${priorLogs}gateway recovered cleanly`, options),
          },
        }),
      ).resolves.toMatchObject({ status: "pass" });
    },
  );

  it("scopes instruction-followthrough diagnostics to requests after the scenario cursor", () => {
    const scenario = requireFlowScenario(
      readQaScenarioById("instruction-followthrough-repo-contract"),
    );
    const flow = JSON.stringify(scenario.execution.flow);
    const cursorIndex = flow.indexOf("/debug/request-cursor");
    const promptIndex = flow.indexOf('"call":"runAgentPrompt"');
    const requestsIndex = flow.indexOf("/debug/requests?after=${requestCursorBefore}");

    expectInOrder(cursorIndex, promptIndex, requestsIndex);
    expect(flow).not.toContain("`${env.mock.baseUrl}/debug/requests`");
  });

  it.each([
    ["thread-memory-isolation", false, false],
    ["memory-tools-channel-context", false, true],
    ["agent-tool-consumption", true, false],
  ] as const)(
    "asserts the complete memory tool chain before %s delivery",
    (scenarioId, immediate, durable) => {
      const { actions } = flowFixture(scenarioId);
      const outboundIndex = durable
        ? callIndex(actions, "waitForCondition", "durableChannelLifecycle")
        : callIndex(actions, "waitForOutboundMessage");
      const requestCollectionIndex = !immediate
        ? callIndex(actions, "waitForCondition", "scenarioRequests")
        : actions.findIndex((action) => matchesAction(action, { set: "scenarioRequests" }));
      expectInOrder(
        requestCollectionIndex,
        ...[
          "scenarioRequests.length === 3",
          "searchPlanRequest.plannedToolName === 'memory_search'",
          "searchResultRequest.toolOutputCallId === searchPlanRequest.plannedToolCallId",
          `${immediate ? "getResultRequest" : "finalRequest"}.toolOutputCallId === searchResultRequest.plannedToolCallId`,
        ].map((needle) => assertionIndex(actions, needle)),
        outboundIndex,
      );

      if (durable) {
        const durableExpr = lambdaExpression(actions[outboundIndex]);
        expect(durableExpr, scenarioId).toContain("event.cursor < finalSent.cursor");
        expect(durableExpr, scenarioId).toContain("event.cursor < previewRetired.cursor");
      }

      if (!immediate) {
        expect(lambdaExpression(actions[requestCollectionIndex]), scenarioId).toContain(
          "requests.length >= 3 ? requests : undefined",
        );
      } else {
        expect(callIndex(actions, "waitForCondition", "scenarioRequests"), scenarioId).toBe(-1);
      }
    },
  );

  it.each([
    {
      scenarioId: "memory-tools-channel-context",
      saveAs: "durableChannelLifecycle",
      cursorName: "busCursorBeforeInbound",
      conversationKey: "channelId",
      markerKey: "expectedNeedle",
      targetPrefix: "channel",
      ms: 30000,
    },
    {
      scenarioId: "agent-progress-evidence",
      saveAs: "durableCompletionLifecycle",
      cursorName: "busCursorBefore",
      conversationKey: "conversationId",
      markerKey: "completionText",
      targetPrefix: "dm",
      ms: 60000,
    },
  ] as const)("isolates $scenarioId durable lifecycle evidence by account", async (fixture) => {
    const { scenario, actions } = flowFixture(fixture.scenarioId);
    const durableWaitIndex = callIndex(actions, "waitForCondition", fixture.saveAs);
    expect(actions[durableWaitIndex]).toMatchObject({
      args: [expect.any(Object), { expr: `liveTurnTimeoutMs(env, ${fixture.ms})` }],
    });
    const cardinalityAssertIndex = assertionIndex(
      actions,
      fixture.scenarioId === "memory-tools-channel-context"
        ? "visibleChannelOutbounds.length === 1"
        : "completionMessages.length === 1",
    );
    expectInOrder(durableWaitIndex, cardinalityAssertIndex);
    const postWaitAssertionPath = actions.slice(durableWaitIndex, cardinalityAssertIndex + 1);

    const config = scenario.execution.config ?? {};
    const conversationId = String(config[fixture.conversationKey]);
    const marker = String(config[fixture.markerKey]);
    const target = `${fixture.targetPrefix}:${conversationId}`;
    const state = createQaBusState();
    const foreignKind = fixture.targetPrefix === "dm" ? "channel" : "dm";
    for (const [accountId, to] of [
      ["foreign", target],
      ["qa-channel", target],
      ["qa-channel", `${foreignKind}:${conversationId}`],
    ] as const) {
      const preview = state.addOutboundMessage({ accountId, to, text: marker });
      state.deleteMessage({ accountId, messageId: preview.id });
      state.addOutboundMessage({ accountId, to, text: marker });
    }

    await expect(
      runActions(
        fixture.scenarioId,
        [
          { set: "outboundStartIndex", value: { expr: "0" } },
          { set: fixture.cursorName, value: { expr: "0" } },
          ...postWaitAssertionPath,
          { assert: { expr: `${fixture.saveAs}.message.accountId === transport.accountId` } },
        ],
        { state },
      ),
    ).resolves.toMatchObject({ status: "pass" });
  });

  it("isolates Active Memory request traces from interleaved heartbeats", async () => {
    const { scenario, actions } = flowFixture("active-memory-preprompt-recall");
    const baselineTrace = actions.find((action) =>
      matchesAction(action, { set: "baselineMockRequests" }),
    );
    const activeTrace = actions.find((action) => matchesAction(action, { set: "activeRequests" }));
    expect(baselineTrace).toBeDefined();
    expect(activeTrace).toBeDefined();
    if (!baselineTrace || !activeTrace) {
      throw new Error("active-memory-preprompt-recall request trace actions are missing");
    }

    const marker = String(scenario.execution.config?.turnMarker);
    const heartbeat = { allInputText: "[OpenClaw heartbeat poll]" };
    const scenarioRequest = (suffix: string) => ({ allInputText: `${marker} ${suffix}` });
    const traces = new Map<string, unknown[]>([
      ["10", [heartbeat, scenarioRequest("baseline main")]],
      [
        "20",
        [
          heartbeat,
          scenarioRequest("You are a memory search agent. search plan"),
          scenarioRequest("You are a memory search agent. search result"),
          scenarioRequest("You are a memory search agent. memory get result"),
          scenarioRequest("active main"),
        ],
      ],
    ]);

    await expect(
      runActions(
        "active-memory-preprompt-recall",
        [
          { set: "requestCursorBeforeBaseline", value: { expr: "10" } },
          baselineTrace,
          { assert: "baselineMockRequests.length === 1" },
          { set: "requestCursorBeforeActive", value: { expr: "20" } },
          activeTrace,
          { assert: "activeRequests.length === 4" },
        ],
        {
          api: {
            env: { mock: { baseUrl: "http://mock.invalid" } },
            fetchJson: async (url: string) =>
              traces.get(new URL(url).searchParams.get("after") ?? "") ?? [],
          },
        },
      ),
    ).resolves.toMatchObject({ status: "pass" });
  });
});
