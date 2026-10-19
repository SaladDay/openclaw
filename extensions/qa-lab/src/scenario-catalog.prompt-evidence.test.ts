import path from "node:path";
import { describe, expect, it } from "vitest";
import { nestedToolHistoryFixture } from "../test/nested-tool-activity-fixture.js";
import { readQaScenarioById, type QaScenarioFlow } from "./scenario-catalog.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const scenarioId = "instruction-profile-artifact-followthrough-live";
const sessionKey = "agent:qa:instruction-profile-artifact:test";
const currentObservation = {
  egress: "responses-sdk",
  payloadVariant: "initial",
  promptSource: "input.developer",
  expectedChars: 4096,
  observedChars: 4096,
  matchesAssembledPrompt: true,
};
const currentEvent = {
  type: "provider.prompt.observed",
  runId: "current-run",
  data: currentObservation,
};

function instructionScenario() {
  const scenario = readQaScenarioById(scenarioId);
  const actions = scenario.execution.flow?.steps[0]?.actions;
  if (!actions) {
    throw new Error("instruction profile scenario has no actions");
  }
  return { actions, config: scenario.execution.config ?? {} };
}

function runEvidence(actions: unknown[], api: Record<string, unknown>, detailsExpr?: string) {
  const flow: QaScenarioFlow = {
    steps: [
      {
        name: "instruction profile evidence",
        actions: [{ set: "sessionKey", value: sessionKey }, ...actions],
        detailsExpr,
      },
    ],
  };
  return runLoadedScenarioFlow(scenarioId, { flow, api });
}

async function runPromptEvidence(params: { events?: unknown[] } = {}) {
  const { actions, config } = instructionScenario();
  const exportIndex = actions.findIndex(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      action.call === "runQaCli",
  );
  const assertionIndex = actions.findIndex(
    (action, index) =>
      index > exportIndex &&
      typeof action === "object" &&
      action !== null &&
      "assert" in action &&
      JSON.stringify(action).includes("current-run provider prompt evidence mismatch"),
  );
  if (exportIndex < 0 || assertionIndex < 0) {
    throw new Error("instruction profile scenario has no provider prompt evidence assertion");
  }
  const instructionContents = config.instructionContents;
  if (typeof instructionContents !== "string") {
    throw new Error("instruction profile scenario has no instruction contents");
  }
  const chars = instructionContents.trimEnd().length;
  return await runEvidence(
    [
      { set: "turn", value: { started: { runId: "current-run" } } },
      ...actions.slice(exportIndex, assertionIndex + 1),
    ],
    {
      path,
      env: {
        gateway: {
          call: async (method: string, input: Record<string, unknown>) => {
            expect(method).toBe("sessions.usage");
            expect(input).toEqual({
              key: sessionKey,
              agentId: "qa",
              range: "all",
              limit: 1,
              includeContextWeight: true,
            });
            return {
              sessions: [
                {
                  key: sessionKey,
                  contextWeight: {
                    injectedWorkspaceFiles: [
                      {
                        path: "/qa/AGENTS.md",
                        missing: false,
                        truncated: false,
                        rawChars: chars,
                        injectedChars: chars,
                      },
                    ],
                  },
                },
              ],
            };
          },
        },
      },
      runQaCli: async () => ({ outputDir: "/qa/trajectory" }),
      fs: {
        readFile: async (file: string) => {
          if (file === path.join("/qa/trajectory", "prompts.json")) {
            return JSON.stringify({ captured: true });
          }
          if (file === path.join("/qa/trajectory", "events.jsonl")) {
            return [
              { type: "trace.metadata", data: { prompting: "[Truncated]" } },
              ...(params.events ?? [currentEvent]),
            ]
              .map((event) => JSON.stringify(event))
              .join("\n");
          }
          throw new Error(`unexpected evidence file: ${file}`);
        },
        rm: async () => undefined,
      },
    },
  );
}

async function runNestedToolHistoryEvidence(params: { leakContextMarker?: boolean } = {}) {
  const { actions, config } = instructionScenario();
  const historyEvidenceAction = actions.find(
    (action) =>
      typeof action === "object" &&
      action !== null &&
      "call" in action &&
      action.call === "waitForCondition" &&
      "saveAs" in action &&
      action.saveAs === "historyEvidence",
  );
  if (!historyEvidenceAction) {
    throw new Error("instruction profile scenario has no history evidence wait");
  }
  const { artifactFile, contextMarker, finalReply, inputFile, nonce } = config;
  if (
    typeof artifactFile !== "string" ||
    typeof contextMarker !== "string" ||
    typeof finalReply !== "string" ||
    typeof inputFile !== "string" ||
    typeof nonce !== "string"
  ) {
    throw new Error("instruction profile scenario has incomplete artifact evidence config");
  }
  const workspaceDir = "/qa-instruction-profile-workspace";
  const messages = [
    nestedToolHistoryFixture({
      toolName: "read",
      toolCallId: "read-instruction-profile-input",
      input: { path: inputFile },
      text: params.leakContextMarker ? `${nonce} ${contextMarker}` : nonce,
    }),
    nestedToolHistoryFixture({
      toolName: "write",
      toolCallId: "write-instruction-profile-artifact",
      input: { path: artifactFile, content: nonce },
      text: `Wrote ${artifactFile}`,
    }),
    { role: "assistant", content: [{ type: "text", text: finalReply }] },
  ];
  return await runEvidence(
    [historyEvidenceAction],
    {
      path,
      env: {
        providerMode: "live-frontier",
        gateway: {
          workspaceDir,
          call: async (method: string, input: Record<string, unknown>) => {
            expect(method).toBe("chat.history");
            expect(input).toEqual({ sessionKey, limit: 100, maxChars: 131072 });
            return { messages };
          },
        },
      },
    },
    "JSON.stringify({ terminalReplies: historyEvidence.visibleAssistant.length, finalText: historyEvidence.final.text })",
  );
}

describe("instruction profile prompt evidence", () => {
  it("bounds prompt evidence to current dispatches despite stale mismatches and marker-bearing diagnostics", async () => {
    const result = await runPromptEvidence({
      events: [
        {
          ...currentEvent,
          runId: "stale-run",
          data: { ...currentObservation, observedChars: 0, matchesAssembledPrompt: false },
        },
        currentEvent,
        {
          type: "context.compiled",
          runId: "current-run",
          data: {
            systemPrompt: "diagnostic support context INSTRUCTION-PROFILE-CONTEXT-MARKER-A6E29D4B",
          },
        },
        {
          ...currentEvent,
          data: {
            ...currentObservation,
            egress: "native-codex-websocket",
            promptSource: "instructions",
          },
        },
      ],
    });
    expect(result.status).toBe("pass");
  });
});

describe("instruction profile tool history evidence", () => {
  it("recognizes canonical nested receipts without counting them as visible replies", async () => {
    const result = await runNestedToolHistoryEvidence();

    expect(result.status).toBe("pass");
    expect(JSON.parse(result.steps[0]?.details ?? "{}")).toEqual({
      terminalReplies: 1,
      finalText: "WROTE instruction-profile-proof.txt",
    });
  });

  it("rejects a protected marker leaked through a canonical nested receipt", async () => {
    await expect(runNestedToolHistoryEvidence({ leakContextMarker: true })).rejects.toThrow(
      "test condition was not met",
    );
  });
});
