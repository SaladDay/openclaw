import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { createReplyRecoveryActorFixture } from "./restart-recovery-claim.test-support.js";

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

it.each(["new input", "accepted input"] as const)(
  "keeps %s admission durable across restart and settles the backend runtime",
  (admission) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = {
        agentId: "main",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        sessionKey: "agent:main:dashboard:durable-admission",
      };
      const executionRunId = "admitted-execution";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      let entry: InternalSessionEntry = {
        sessionId: "admitted-session",
        updatedAt: 1,
        startedAt: 1,
        endedAt: 2,
        runtimeMs: 1,
        status: "done",
        lastRunId: "previous-run",
        ...(admission === "accepted input"
          ? {
              status: undefined,
              endedAt: undefined,
              runtimeMs: undefined,
              lastRunId: undefined,
              lifecycleRunId: executionRunId,
              restartRecoveryDeliveryRunId: "admitted-input",
              restartRecoveryDeliverySourceRunId: "admitted-input",
              restartRecoverySourceIngress: "control-ui",
              restartRecoveryDeliveryRequestFingerprint: "request-fingerprint",
            }
          : {}),
      };
      await replaceSessionEntry(scope, entry);
      {
        const recorder =
          admission === "new input"
            ? createUserTurnTranscriptRecorder({
                message: { role: "user", content: "continue the task", timestamp: 3 },
                target: { ...scope, sessionId: entry.sessionId, sessionEntry: entry },
                updateMode: "none",
              })
            : undefined;
        await using actor = createReplyRecoveryActorFixture({
          ...scope,
          getSessionId: () => entry.sessionId,
        });
        const controller = createReplyRestartRecoveryClaimController({
          acquireSessionActor: () => actor.acquireSessionActor(),
          isRestartAbort: () => false,
          resolveDeliveryContext: () => undefined,
          ...scope,
          admissionRunId: "admitted-input",
          executionRunId,
          lifecycleGeneration,
          getEntry: () => entry,
          getSessionId: () => entry.sessionId,
          setEntry: (next) => {
            entry = next;
          },
        });
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
      }
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest(state.root);
      const admitted = expectDefined(
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
        "admitted session survives restart",
      );
      expect(admitted.lifecycleRunId).toBe(executionRunId);
      expect(admitted.status).toBeUndefined();
      expect(admitted.endedAt).toBeUndefined();
      expect(admitted.runtimeMs).toBeUndefined();
      expect(admitted.lastRunId).toBeUndefined();
      expect(admitted.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
      expect(admitted.restartRecoveryRuns).toEqual([
        { runId: executionRunId, lifecycleGeneration },
      ]);
      if (admission === "accepted input") {
        expect(admitted.updatedAt).toBe(1);
      } else {
        expect(admitted.updatedAt).toBeGreaterThan(1);
      }

      const startedAt = expectDefined(admitted.startedAt, "admission records a start time") + 10;
      const event = { runId: executionRunId, lifecycleGeneration, sessionId: entry.sessionId };
      await persistGatewaySessionLifecycleEvent({
        ...scope,
        event: { ...event, ts: startedAt, data: { phase: "start", startedAt } },
      });
      expect(loadSessionEntry(scope)?.startedAt).toBe(admitted.startedAt);
      await persistGatewaySessionLifecycleEvent({
        ...scope,
        event: {
          ...event,
          ts: startedAt + 20,
          data: { phase: "end", startedAt, endedAt: startedAt + 20 },
        },
      });
      await closeOpenClawAgentDatabasesAsync(state.root);
      closeOpenClawAgentDatabasesForTest(state.root);
      const settled = expectDefined(
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
        "settled session survives restart",
      );
      expect(settled).toMatchObject({
        status: "done",
        startedAt,
        endedAt: startedAt + 20,
        runtimeMs: 20,
        lastRunId: executionRunId,
      });
      expect(settled.lifecycleRunId).toBeUndefined();
      expect(settled.restartRecoveryRuns).toBeUndefined();
    }),
);

it("keeps an authenticated peer follow-up internal while retaining its operator source", () =>
  withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const scope = {
      agentId: "main",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
      sessionKey: "agent:main:dashboard:peer-target",
    };
    let entry: InternalSessionEntry = { sessionId: "peer-session", updatedAt: 1 };
    await replaceSessionEntry(scope, entry);
    const operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "peer-operator",
      scopes: ["operator.read"],
      assertCurrent() {},
      recoverySnapshot: {
        profileId: "peer-operator",
        scopes: ["operator.read"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "peer-grant",
          role: "operator",
          authMethod: "token",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "control-ui",
      },
    });

    await using actor = createReplyRecoveryActorFixture({
      ...scope,
      getSessionId: () => entry.sessionId,
    });
    const controller = createReplyRestartRecoveryClaimController({
      ...scope,
      admissionRunId: "peer-run",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      getEntry: () => entry,
      getSessionId: () => entry.sessionId,
      setEntry: (next) => {
        entry = next;
      },
      acquireSessionActor: () => actor.acquireSessionActor(),
      isRestartAbort: () => false,
      resolveDeliveryContext: () => undefined,
      operatorAuthority,
      sourceReplyDeliveryMode: "message_tool_only",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:main:dashboard:peer-source",
        sourceChannel: "webchat",
      },
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    expect(loadSessionEntry(scope)).toMatchObject({
      restartRecoveryDeliverySourceRunId: "peer-run",
      restartRecoverySourceIngress: "internal",
      restartRecoverySourceReplyDeliveryMode: "message_tool_only",
      restartRecoveryOperatorSource: {
        sessionKey: scope.sessionKey,
        sourceRunId: "peer-run",
        snapshot: { profileId: "peer-operator", sourceIngress: "control-ui" },
      },
    });
  }));
