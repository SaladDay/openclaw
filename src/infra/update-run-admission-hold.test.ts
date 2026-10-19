import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import { captureUpdateRunRedactionFacts } from "./update-run-codec.js";
import { executeUpdateRunCommand } from "./update-run-dispatch.worker.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { openUpdateRunWriter } from "./update-run-mutation.worker.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let env: { OPENCLAW_STATE_DIR: string };
beforeAll(() => {
  env = { OPENCLAW_STATE_DIR: dirs.make("update-admission-hold-") };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.each(["delayed", "revoked", "non-converging"])(
  "releases the writer before retrying %s commit admission",
  async (outcome) => {
    const options = { env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    await closeOpenClawStateDatabaseAsync();
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const writer = openUpdateRunWriter(options);
    const competitor = new DatabaseSync(databasePath);
    competitor.exec("PRAGMA busy_timeout = 0");
    let revoked = false;
    const admission = createSqliteWorkerWriteAdmission(() => {
      if (revoked) {
        throw new Error("update custody revoked");
      }
    }, [databasePath])({ settled: Promise.resolve({ kind: "completed" }) }).admission;
    let now = process.hrtime.bigint();
    vi.spyOn(process.hrtime, "bigint").mockImplementation(() => now);
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    let stage: string | undefined;
    let delayed = false;
    let commitAttempts = 0;
    const requestAdmission = workerAdmission.requestSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "requestSqliteWorkerOperationAdmission").mockImplementation(
      (request) => {
        stage = request.stage;
        try {
          return requestAdmission(request);
        } finally {
          stage = undefined;
        }
      },
    );
    let competingWrite = false;
    vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
      if (stage === "commit" && (!delayed || outcome === "non-converging")) {
        // Stop the defective unlimited loop deterministically instead of hanging the test.
        if (++commitAttempts > 120) {
          throw new Error("commit admission retried beyond its budget");
        }
        delayed = true;
        // Delay the host decision, not SQL; no wall-clock wait is needed.
        expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow("database is locked");
        now += 20_537_000_000n;
        elapsedMs += 20_537;
        if (timeout === undefined) {
          admission.service();
        }
        return "timed-out";
      }
      if (stage === "transaction" && delayed && !competingWrite) {
        competitor.exec("BEGIN IMMEDIATE");
        competitor
          .prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?")
          .run(JSON.stringify({ sessionKey: "competing-writer" }), run.runId);
        competitor.exec("COMMIT");
        competingWrite = true;
        revoked = outcome === "revoked";
      }
      admission.service();
      return "ok";
    });
    try {
      const execute = () =>
        runWithSqliteWorkerStateContext({ environment: env }, () =>
          workerAdmission.withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            executeUpdateRunCommand(
              {
                type: "updateRuns.recordPhase",
                input: {
                  runId: run.runId,
                  redactionFacts: captureUpdateRunRedactionFacts(env),
                  phase: "validating",
                  patch: {},
                },
              },
              { path: databasePath, env },
              () => writer,
            ),
          ),
        );
      if (outcome === "non-converging") {
        expect(execute).toThrow(/120 attempts.*rolled back.*openclaw update repair/);
        expect(commitAttempts).toBe(6);
        competitor.exec("BEGIN IMMEDIATE");
        competitor.exec("ROLLBACK");
      } else if (outcome === "revoked") {
        expect(execute).toThrow("admission was refused");
      } else {
        expect(execute()).toMatchObject({ kind: "recorded", record: { phase: "validating" } });
      }
      expect(competingWrite).toBe(true);
      expect(getUpdateRun(run.runId, options)).toMatchObject({
        phase: outcome === "delayed" ? "validating" : "requested",
        origin: { sessionKey: "competing-writer" },
      });
    } finally {
      admission.finish();
      competitor.close();
      writer.close();
    }
  },
);
