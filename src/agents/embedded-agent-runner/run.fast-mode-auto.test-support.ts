import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;
let resetAgentEventsForTest: typeof import("../../infra/agent-events.js").resetAgentEventsForTest;

function successAttempt(provider: string, model: string): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: ["done"],
    lastAssistant: {
      stopReason: "stop",
      provider,
      model,
      content: [{ type: "text", text: "done" }],
      usage: { input: 100, output: 5, totalTokens: 105 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

type AttemptParams = Parameters<typeof mockedRunEmbeddedAttempt>[0];

function resolveAttemptFastMode({ fastMode }: AttemptParams): void {
  if (typeof fastMode === "function") {
    fastMode();
  }
}

function startFastAttempt(overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]>) {
  const events: Array<{ data?: { summary?: unknown } }> = [];
  const toolResults: Array<{ text?: string; channelData?: Record<string, unknown> }> = [];
  const done = createDeferred<EmbeddedRunAttemptResult>();
  const started = createDeferred();
  let params: AttemptParams | undefined;
  mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
    params = input;
    resolveAttemptFastMode(input);
    started.resolve();
    return done.promise;
  });
  const run = runEmbeddedAgent({
    ...createOverflowRunParams(state),
    provider: "ollama",
    model: "glm-5.1:cloud",
    fastMode: "auto",
    fastModeAutoOnSeconds: 30,
    ...overrides,
    onAgentEvent: (event) => {
      events.push(event);
      return overrides.onAgentEvent?.(event);
    },
    onToolResult: (payload) => {
      toolResults.push(payload);
      return overrides.onToolResult?.(payload);
    },
  });
  return {
    events,
    toolResults,
    run,
    started: started.promise,
    complete: () => done.resolve(successAttempt("ollama", "glm-5.1:cloud")),
    get params() {
      return params;
    },
  };
}

describe("runEmbeddedAgent fast auto progress", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ onAgentEvent, resetAgentEventsForTest } = await import("../../infra/agent-events.js"));
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.fast-mode-auto" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetAgentEventsForTest();
    await state?.cleanup();
  });

  it("preserves explicit Ultrafast through attempt dispatch", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      expect(params.fastMode).toBe("ultrafast");
      return successAttempt("ollama", "glm-5.1:cloud");
    });
    await runEmbeddedAgent({ ...createOverflowRunParams(state), fastMode: "ultrafast" });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
  });

  it("uses the selected model's auto cutoff when the caller omits one", async () => {
    let attemptParams: AttemptParams | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      attemptParams = params;
      resolveAttemptFastMode(params);
      return successAttempt("ollama", "glm-5.1:cloud");
    });

    const config = {
      agents: {
        defaults: {
          models: {
            "ollama/glm-5.1:cloud": { params: { fastAutoOnSeconds: 23 } },
          },
        },
      },
    };
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot(config);
    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      provider: "ollama",
      model: "glm-5.1:cloud",
      config,
      fastMode: "auto",
    });

    expect(attemptParams?.fastModeAutoOnSeconds).toBe(23);
  });

  it("emits auto-off once at the first completed boundary past the threshold, then resets", async () => {
    vi.useFakeTimers();

    const globalSummaries: string[] = [];
    const stopGlobalCapture = onAgentEvent((event: AgentEventPayload) => {
      if (event.runId !== "run-fast-auto-retry" || event.stream !== "item") {
        return;
      }
      const summary = event.data.summary;
      if (typeof summary === "string") {
        globalSummaries.push(summary);
      }
    });
    const attempt = startFastAttempt({ runId: "run-fast-auto-retry" });
    const { events, toolResults, run: resultPromise, complete: completeAttempt } = attempt;
    try {
      await vi.advanceTimersByTimeAsync(0);
      await attempt.started;
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
      expect(toolResults).toHaveLength(0);
      expect(globalSummaries).toHaveLength(0);

      attempt.params?.onRunProgress?.({ reason: "model-progress" });
      await vi.advanceTimersByTimeAsync(2);
      expect(events).toHaveLength(0);
      expect(toolResults).toHaveLength(0);
      expect(globalSummaries).toHaveLength(0);

      await attempt.params?.onToolResult?.({ text: "🛠️ Exec: still running" });
      await vi.advanceTimersByTimeAsync(2);
      expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
      expect(toolResults.map((payload) => payload.text)).toEqual(["🛠️ Exec: still running"]);
      expect(globalSummaries).toHaveLength(0);

      await attempt.params?.onAgentEvent?.({
        stream: "tool",
        data: { phase: "start", name: "exec" },
      });
      await vi.advanceTimersByTimeAsync(2);

      expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
      expect(toolResults.map((payload) => payload.text)).toEqual(["🛠️ Exec: still running"]);
      expect(globalSummaries).toHaveLength(0);

      await attempt.params?.onAgentEvent?.({
        stream: "tool",
        data: { phase: "result", name: "exec" },
      });
      await vi.advanceTimersByTimeAsync(2);

      expect(events.map((event) => event.data?.summary).filter(Boolean)).toHaveLength(0);
      expect(globalSummaries).toHaveLength(0);

      await attempt.params?.onToolStreamBoundary?.();
      await vi.advanceTimersByTimeAsync(2);

      const summaries = events.map((event) => event.data?.summary).filter(Boolean);
      expect(summaries).toContain("💨Fast: auto-off(31s>=30s)");
      expect(globalSummaries).toContain("💨Fast: auto-off(31s>=30s)");
      expect(toolResults.some((payload) => payload.text === "💨Fast: auto-off(31s>=30s)")).toBe(
        true,
      );
      expect(toolResults.at(-1)?.channelData?.openclawProgressKind).toBe("fast-mode-auto");

      await vi.advanceTimersByTimeAsync(14_000);
      await attempt.params?.onAgentEvent?.({
        stream: "tool",
        data: { phase: "result", name: "exec" },
      });
      await attempt.params?.onToolStreamBoundary?.();
      await attempt.params?.onToolResult?.({ text: "🛠️ Exec: later tool summary" });
      completeAttempt?.();
      await resultPromise;

      const autoOff = (text: unknown) =>
        typeof text === "string" && text.includes("Fast: auto-off");
      expect(events.map((event) => event.data?.summary).filter(autoOff)).toEqual([
        "💨Fast: auto-off(31s>=30s)",
      ]);
      expect(toolResults.map((payload) => payload.text).filter(autoOff)).toEqual([
        "💨Fast: auto-off(31s>=30s)",
      ]);
      expect(attempt.params?.fastModeAutoProgressState).toMatchObject({
        offAnnounced: true,
        resetAnnounced: true,
      });
      expect(events.map((event) => event.data?.summary)).toContain("💨Fast: auto-on");
      expect(toolResults.map((payload) => payload.text)).toContain("💨Fast: auto-on");
      expect(globalSummaries).toContain("💨Fast: auto-on");
    } finally {
      completeAttempt?.();
      try {
        await resultPromise;
      } finally {
        stopGlobalCapture();
      }
    }
  });

  it.each(["agent-event", "tool-result"] as const)(
    "keeps successful runs when fast auto-off %s delivery fails",
    async (failureTarget) => {
      vi.useFakeTimers();

      const attempt = startFastAttempt({
        runId: `run-fast-auto-off-${failureTarget}`,
        fastModeAutoOnSeconds: undefined,
        timeoutMs: 120_000,
        onAgentEvent: (event) => {
          const summary = event.data?.summary;
          if (
            failureTarget === "agent-event" &&
            typeof summary === "string" &&
            summary.startsWith("💨Fast: auto-off")
          ) {
            throw new Error("auto-off event delivery failed");
          }
        },
        onToolResult: (payload) => {
          if (failureTarget === "tool-result" && payload.text?.startsWith("💨Fast: auto-off")) {
            throw new Error("auto-off tool delivery failed");
          }
        },
      });
      const { events, toolResults, run: resultPromise, complete: completeAttempt } = attempt;
      try {
        await vi.advanceTimersByTimeAsync(0);
        await attempt.started;
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(61_000);
        await attempt.params?.onAgentEvent?.({
          stream: "tool",
          data: { phase: "result", name: "exec" },
        });
        await attempt.params?.onToolStreamBoundary?.();

        completeAttempt?.();
        await expect(resultPromise).resolves.toBeTruthy();

        expect(events.map((event) => event.data?.summary).filter(Boolean)).toContainEqual(
          expect.stringMatching(/^💨Fast: auto-off\(/u),
        );
        if (failureTarget === "tool-result") {
          expect(toolResults.map((payload) => payload.text)).toContainEqual(
            expect.stringMatching(/^💨Fast: auto-off\(/u),
          );
        }
      } finally {
        completeAttempt?.();
        await resultPromise;
      }
    },
  );
});
