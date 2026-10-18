import { vi } from "vitest";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { createInitialCronState } from "./state.ts";
import type { CronState } from "./types.ts";

export function createState(overrides: Partial<CronState> = {}): CronState {
  return {
    ...createInitialCronState({ connected: true }),
    ...overrides,
  };
}

export function createMethodRequest(responses: Readonly<Record<string, unknown>>) {
  return vi.fn(async (method: string, _payload?: unknown) => responses[method] ?? {});
}

export function createCronJob(overrides: Partial<CronJob> & Pick<CronJob, "id" | "name">): CronJob {
  return {
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    configRevision: "config-revision-1",
    schedule: { kind: "cron", expr: "0 * * * *" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
    ...overrides,
  };
}

export function createStateWithRequest(
  request: unknown,
  overrides: Partial<CronState> = {},
): CronState {
  return createState({
    client: { request } as unknown as CronState["client"],
    ...overrides,
  });
}

export function cronJobsListResponse(
  jobs: CronJob[] = [],
  overrides: Partial<Omit<CronJobsListResult, "jobs">> = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "cron-jobs-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
    ...overrides,
  };
}
