// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { CronJob, CronJobsListResult } from "../../api/types.ts";
import { parseCronDurationMs } from "../../lib/cron/decimal.ts";
import {
  addCronJob,
  toggleCronJob,
  loadCronScopeStats,
  loadCronJobsPage,
  removeCronJob,
  startCronEdit,
  startCronClone,
} from "../../lib/cron/index.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import {
  createState,
  createMethodRequest,
  createCronJob,
  createStateWithRequest,
  cronJobsListResponse,
} from "./controller.test-support.ts";

function createCronRequest(jobId: string, options: { existing?: boolean } = {}) {
  const existingJob = createCronJob({ id: jobId, name: "Existing job" });
  const jobs = options.existing ? [existingJob] : [];
  return createMethodRequest({
    "cron.add": { id: jobId },
    "cron.update": existingJob,
    "cron.list": cronJobsListResponse(jobs),
    "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
  });
}

function findRequestCall(
  calls: ReadonlyArray<readonly [method: string, payload?: unknown]>,
  method: string,
): readonly [method: string, payload?: unknown] {
  const call = calls.find(([callMethod]) => callMethod === method);
  if (!call) {
    throw new Error(`Expected ${method} request call`);
  }
  return call;
}

function createCronSubmitHarness(
  jobId: string,
  options: {
    method?: "cron.add" | "cron.update";
    form?: Partial<CronState["cronForm"]>;
  } = {},
) {
  const method = options.method ?? "cron.add";
  const request = createCronRequest(jobId, { existing: method === "cron.update" });
  const state = createStateWithRequest(request);
  if (method === "cron.update") {
    const job = createCronJob({ id: jobId, name: "Existing job" });
    state.cronJobs = [job];
    startCronEdit(state, job);
  }
  state.cronForm = { ...DEFAULT_CRON_FORM, ...options.form };
  const submit = async () => {
    const result = await addCronJob(state);
    return { call: findRequestCall(request.mock.calls, method), result };
  };
  return { request, state, submit };
}

function createCronEditHarness(job: CronJob) {
  const request = createCronRequest(job.id, { existing: true });
  const state = createStateWithRequest(request, { cronJobs: [job] });
  startCronEdit(state, job);
  const submit = async () => {
    await addCronJob(state);
    return findRequestCall(request.mock.calls, "cron.update");
  };
  return { request, state, submit };
}

function revisionConflict() {
  return Object.assign(new Error("cron job definition changed"), {
    details: { code: "CRON_JOB_CHANGED" },
  });
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requestPayload(call: readonly [method: string, payload?: unknown]) {
  return requireRecord(call[1], `${call[0]} payload`);
}

function requestPatch(call: readonly [method: string, payload?: unknown]) {
  return requireRecord(requestPayload(call).patch, `${call[0]} patch`);
}

describe("cron controller", () => {
  it("preserves an explicit zero timeout in the saved payload", async () => {
    const { call, result } = await createCronSubmitHarness("no-timeout", {
      method: "cron.update",
      form: { name: "No timeout", payloadText: "Run until complete", timeoutSeconds: "0" },
    }).submit();
    expect(result).toEqual({ saved: true, jobId: "no-timeout" });
    expect(requestPatch(call).payload).toEqual({
      kind: "agentTurn",
      message: "Run until complete",
      timeoutSeconds: 0,
    });
  });

  it.each([
    {
      name: "Webhook",
      form: { deliveryMode: "webhook", deliveryTo: "https://example.invalid/cron" },
      delivery: expect.objectContaining({ mode: "webhook", to: "https://example.invalid/cron" }),
    },
    {
      name: "Main event",
      form: {
        sessionTarget: "main",
        payloadKind: "systemEvent",
        deliveryMode: "announce",
        deliveryTo: "buddy",
      },
      delivery: { mode: "none" },
    },
  ] as const)("submits normalized delivery for $name", async ({ name, form, delivery }) => {
    const { state, submit } = createCronSubmitHarness(name, {
      form: { name, payloadText: "run", ...form },
    });
    const { call, result } = await submit();
    expect(result.saved).toBe(true);
    expect(requestPayload(call).name).toBe(name);
    expect(requestPayload(call).delivery).toEqual(delivery);
    expect(state.cronForm.deliveryMode).toBe("none");
  });

  it.each([{ job: { id: "wrapped" } }])("returns the saved id from %j", async (response) => {
    const request = createMethodRequest({
      "cron.add": response,
      "cron.list": cronJobsListResponse(),
      "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
    });
    const state = createStateWithRequest(request, {
      cronForm: {
        ...DEFAULT_CRON_FORM,
        name: "ID echo",
        payloadText: "run",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
      },
    });
    expect(await addCronJob(state)).toEqual({
      saved: true,
      jobId: "wrapped",
    });
  });

  it("clears stored payload overrides, including a zero timeout", async () => {
    const { state, submit } = createCronEditHarness(
      createCronJob({
        id: "clear-payload",
        name: "Clear overrides",
        payload: {
          kind: "agentTurn",
          message: "do work",
          model: "openai/gpt-5.5",
          thinking: "high",
          timeoutSeconds: 0,
        },
      }),
    );
    expect(state.cronForm.timeoutSeconds).toBe("0");
    Object.assign(state.cronForm, { payloadModel: "", payloadThinking: "", timeoutSeconds: "" });
    expect(requestPatch(await submit()).payload).toEqual({
      kind: "agentTurn",
      message: "do work",
      model: null,
      thinking: null,
      timeoutSeconds: null,
    });
  });

  it("saves exact timing and explicit owner clearing in an event update", async () => {
    const { state, submit } = createCronEditHarness(createCronJob({ id: "job", name: "Event" }));
    Object.assign(state.cronForm, {
      clearAgent: true,
      scheduleExact: true,
      payloadKind: "systemEvent",
      payloadText: "updated",
    });
    const patch = requestPatch(await submit());
    expect(patch).toMatchObject({
      agentId: null,
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 0 },
      payload: { kind: "systemEvent", text: "updated" },
      delivery: { mode: "none" },
    });
    expect(patch).not.toHaveProperty("deleteAfterRun");
  });

  it("requires a loaded config revision before form saves and toggles", async () => {
    const job = createCronJob({
      id: "job-missing-revision",
      name: "Missing revision",
      configRevision: undefined,
    });
    const request = vi.fn(async () => {
      throw new Error("unguarded mutation should not be issued");
    });
    const saveState = createStateWithRequest(request, { cronJobs: [job] });
    startCronEdit(saveState, job);
    saveState.cronForm.name = "Unsafe edit";

    await expect(addCronJob(saveState)).resolves.toEqual({ saved: false });
    expect(saveState.cronEditingJob?.id).toBe(job.id);
    expect(saveState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();

    const toggleState = createStateWithRequest(request, { cronJobs: [job] });
    await expect(toggleCronJob(toggleState, job, false)).resolves.toBe(false);
    expect(toggleState.cronError).toContain("configuration revision");
    expect(request).not.toHaveBeenCalled();
  });

  it("reloads a conflicted definition without adding it to filtered results", async () => {
    const stale = createCronJob({ id: "conflict", name: "Loaded", configRevision: "stale" });
    const current = {
      ...stale,
      name: "Current",
      description: "Latest definition",
      configRevision: "current",
    };
    const saved = { ...current, name: "Retried", configRevision: "saved" };
    const updates = vi.fn(async (_payload?: unknown) => saved);
    updates.mockRejectedValueOnce(revisionConflict());
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.update") {
        return updates(payload);
      }
      if (method === "cron.list") {
        return cronJobsListResponse();
      }
      if (method === "cron.get") {
        return current;
      }
      return { enabled: true, jobs: 1 };
    });
    const state = createStateWithRequest(request, { cronJobs: [stale], cronJobsQuery: "filtered" });
    startCronEdit(state, stale);
    state.cronForm.name = "Unsaved";
    state.cronJobs = [current];
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ query: "filtered" }),
    );
    expect(request).toHaveBeenCalledWith("cron.get", { id: stale.id });
    expect(state).toMatchObject({
      cronJobs: [],
      cronJobsTotal: 0,
      cronEditingJob: current,
      cronForm: { name: "Current", description: "Latest definition" },
    });
    state.cronForm.name = "Retried";
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: stale.id });
    expect(
      updates.mock.calls.map(
        ([payload]) => requireRecord(payload, "update").expectedConfigRevision,
      ),
    ).toEqual(["stale", "current"]);
    expect(state.cronJobs).toEqual([]);
    expect(state.cronEditingJob).toEqual(saved);
  });

  it("keeps the draft's frozen revision when exact conflict recovery fails", async () => {
    const stale = createCronJob({ id: "conflict", name: "Loaded", configRevision: "stale" });
    const current = { ...stale, name: "Current", configRevision: "current" };
    const firstList = createDeferred<CronJobsListResult>();
    const list = vi
      .fn()
      .mockReturnValueOnce(firstList.promise)
      .mockResolvedValue(cronJobsListResponse([current]));
    const revisions: unknown[] = [];
    const request = vi.fn(async (method: string, payload?: unknown) => {
      if (method === "cron.update") {
        revisions.push(requireRecord(payload, "update").expectedConfigRevision);
        throw revisionConflict();
      }
      if (method === "cron.list") {
        return list();
      }
      if (method === "cron.get") {
        throw new Error("Exact refresh unavailable");
      }
      return { enabled: true, jobs: 1 };
    });
    const state = createStateWithRequest(request, { cronJobs: [stale] });
    startCronEdit(state, stale);
    state.cronForm.name = "Unsaved";
    const pending = loadCronJobsPage(state, { tableFilters: true });
    expect(list).toHaveBeenCalledOnce();
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronForm.name).toBe("Unsaved");
    expect(state.cronEditingJob?.configRevision).toBe("stale");
    expect(state.cronError).toContain("could not be loaded");
    firstList.resolve(cronJobsListResponse([current]));
    await pending;
    expect(state).toMatchObject({
      cronJobs: [current],
      cronForm: { name: "Unsaved" },
      cronEditingJob: { configRevision: "stale" },
    });
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(revisions).toEqual(["stale", "stale"]);
  });

  it("commits authoritative toggle state and advances an open editor revision", async () => {
    const loadedJob = createCronJob({
      id: "job-authoritative-toggle",
      name: "Toggle job",
      enabled: true,
      configRevision: "revision-loaded",
    });
    const updatedJob = {
      ...loadedJob,
      enabled: false,
      updatedAtMs: 2,
      configRevision: "revision-toggled",
    };
    const listResponse = createDeferred<CronJobsListResult>();
    const request = createMethodRequest({
      "cron.update": updatedJob,
      "cron.list": listResponse.promise,
      "cron.status": { enabled: true, jobs: 1 },
    });
    const state = createStateWithRequest(request, { cronJobs: [loadedJob] });
    startCronEdit(state, loadedJob);
    state.cronForm.name = "Unsaved rename";

    const toggle = toggleCronJob(state, loadedJob, false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("cron.list", expect.anything()));

    expect(request).toHaveBeenCalledWith("cron.update", {
      id: loadedJob.id,
      expectedConfigRevision: "revision-loaded",
      patch: { enabled: false },
    });
    expect(state.cronJobs).toEqual([updatedJob]);
    expect(state.cronEditingJob).toEqual(updatedJob);
    expect(state.cronForm.name).toBe("Unsaved rename");

    listResponse.resolve(cronJobsListResponse([updatedJob]));
    await expect(toggle).resolves.toBe(true);

    await addCronJob(state);
    const updateCalls = request.mock.calls.filter(([method]) => method === "cron.update");
    expect(updateCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        expectedConfigRevision: "revision-toggled",
        patch: expect.objectContaining({ name: "Unsaved rename" }),
      }),
    );
  });

  it("removes confirmed jobs locally before a failed reconciliation", async () => {
    const removedJob = createCronJob({ id: "job-remove-local", name: "Remove locally" });
    const remainingJob = createCronJob({ id: "job-remaining", name: "Keep locally" });
    const request = vi.fn(async (method: string) => {
      if (method === "cron.remove") {
        return { ok: true, removed: true };
      }
      if (method === "cron.list") {
        throw new Error("reconciliation unavailable");
      }
      if (method === "cron.status") {
        return { enabled: true, jobs: 1 };
      }
      return {};
    });
    const state = createStateWithRequest(request, {
      cronJobs: [removedJob, remainingJob],
      cronJobsTotal: 2,
      cronRunsJobId: removedJob.id,
      cronRuns: [{ ts: 1, jobId: removedJob.id, action: "finished", status: "ok" }],
      cronRunsTotal: 1,
    });
    startCronEdit(state, removedJob);

    await removeCronJob(state, removedJob);

    expect(state.cronJobs).toEqual([remainingJob]);
    expect(state.cronJobsTotal).toBe(1);
    expect(state.cronEditingJob).toBeNull();
    expect(state.cronRunsJobId).toBeNull();
    expect(state.cronRuns).toEqual([]);
  });

  it("clears persisted delivery routing when its inputs are blanked", async () => {
    const job = createCronJob({
      id: "clear-routing",
      name: "Routed job",
      delivery: { mode: "announce", channel: "telegram", to: "123", accountId: "ops" },
    });
    const { state, submit } = createCronEditHarness(job);
    Object.assign(state.cronForm, {
      deliveryChannel: "last",
      deliveryTo: " ",
      deliveryAccountId: " ",
    });
    expect(requestPatch(await submit()).delivery).toMatchObject({
      mode: "announce",
      channel: "last",
      to: null,
      accountId: null,
    });
  });

  it.each(["unknown"])(
    "requires an explicit delivery choice before editing a persisted mode %s",
    async (mode) => {
      const job = createCronJob({
        id: "legacy-delivery",
        name: "Garden summary",
        delivery: { mode: "announce", channel: "telegram", to: "garden-room" },
      });
      Reflect.set(job.delivery!, "mode", mode);
      const original = structuredClone(job);
      const { request, state } = createCronEditHarness(job);
      state.cronForm.name = "Renamed garden summary";
      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
      expect(job).toEqual(original);
      expect(state.cronFieldErrors.deliveryMode).toBe("cron.errors.deliveryModeRequired");

      state.cronForm.deliveryMode = "announce";
      expect(await addCronJob(state)).toMatchObject({ saved: true, jobId: job.id });
      const patch = requestPatch(findRequestCall(request.mock.calls, "cron.update"));
      expect(patch.name).toBe("Renamed garden summary");
      expect(patch.delivery).toMatchObject({
        mode: "announce",
        channel: "telegram",
        to: "garden-room",
      });
      expect(
        validateCronUpdateParams(
          requestPayload(findRequestCall(request.mock.calls, "cron.update")),
        ),
      ).toBe(true);
    },
  );

  it("preserves configured duration precision when editing a staggered cron expression", async () => {
    const job = createCronJob({
      id: "job-exact-stagger",
      name: "Exact stagger",
      schedule: { kind: "cron", expr: "0 * * * *", staggerMs: 1_001 },
    });
    const { state, submit } = createCronEditHarness(job);
    const displayedAmount = state.cronForm.staggerAmount;
    state.cronForm.cronExpr = "*/5 * * * *";

    const call = await submit();

    expect({ displayedAmount, schedule: requestPatch(call).schedule }).toEqual({
      displayedAmount: "1.001",
      schedule: { kind: "cron", expr: "*/5 * * * *", staggerMs: 1_001 },
    });
    expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
  });

  it("accepts prefixed-number stagger input", async () => {
    const { call, result } = await createCronSubmitHarness("stagger", {
      form: {
        name: "Stagger",
        scheduleKind: "cron",
        cronExpr: "0 * * * *",
        staggerAmount: "0x10",
        staggerUnit: "seconds",
        payloadText: "run",
      },
    }).submit();
    expect(result.saved).toBe(true);
    expect(requestPayload(call).schedule).toEqual({
      kind: "cron",
      expr: "0 * * * *",
      staggerMs: 16_000,
    });
    expect(validateCronAddParams(requestPayload(call))).toBe(true);
  });

  it("preserves the trigger draft and inventory when its syntax is rejected", async () => {
    const job = createCronJob({
      id: "syntax",
      name: "Conditional job",
      trigger: { script: "return { fire: true }" },
    });
    const { request, state } = createCronEditHarness(job);
    state.cronForm.triggerScript = "const x = ;";
    request.mockRejectedValue(new Error("Invalid trigger syntax"));
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronError).toBe("Invalid trigger syntax");
    expect(state.cronForm.triggerScript).toBe("const x = ;");
    expect(state.cronJobs).toEqual([job]);
    expect(state.cronEditingJob).toBe(job);
  });

  it("requires an explicit clear before saving an existing script payload with a condition trigger", async () => {
    const job = createCronJob({
      id: "job-script-trigger-conflict",
      name: "Conflicting script",
      schedule: { kind: "every", everyMs: 30_000 },
      payload: { kind: "script", script: "json({ state: {} })" },
      trigger: { script: "json({ fire: true })" },
    });
    const { request, state, submit } = createCronEditHarness(job);

    expect(state.cronForm.triggerEnabled).toBe(true);
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors.triggerScript).toBe("cron.errors.triggerScriptPayloadUnsupported");
    expect(request).not.toHaveBeenCalled();

    state.cronForm.triggerEnabled = false;
    const call = await submit();

    expect(requestPatch(call).trigger).toBeNull();
    expect(requestPatch(call)).not.toHaveProperty("payload");
  });

  it.each([
    {
      name: "blank routing fields",
      form: {
        failureAlertChannel: "last",
        failureAlertDeliveryMode: "",
        failureAlertAfter: "",
        failureAlertTo: "",
        failureAlertCooldownSeconds: "",
        failureAlertAccountId: "",
      },
      expected: {
        channel: "last",
        mode: null,
        includeSkipped: true,
        after: null,
        to: null,
        cooldownMs: null,
        accountId: null,
      },
    },
    { name: "inheritance", form: { failureAlertMode: "inherit" }, expected: null },
  ] as const)("clears persisted failure alert overrides with $name", async ({ form, expected }) => {
    const job = createCronJob({
      id: "job-clear-alert-fields",
      name: "Clear failure alert fields",
      delivery: { mode: "announce" },
      failureAlert: {
        after: 2,
        channel: "telegram",
        to: "123456",
        cooldownMs: 60_000,
        accountId: "bot-a",
        mode: "webhook",
        includeSkipped: true,
      },
    });
    const { state, submit } = createCronEditHarness(job);

    Object.assign(state.cronForm, form);
    const call = await submit();

    // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify explicit clears on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual(expected);
  });

  it.each<[Partial<CronState["cronForm"]>, string, string]>([
    [
      { scheduleKind: "cron", staggerAmount: "8640000000000.001", staggerUnit: "seconds" },
      "staggerAmount",
      "cron.errors.staggerAmountInvalid",
    ],
    [
      { scheduleKind: "cron", staggerAmount: "0.0001" },
      "staggerAmount",
      "cron.errors.staggerAmountInvalid",
    ],
    [{ timeoutSeconds: "Infinity" }, "timeoutSeconds", "cron.errors.timeoutInvalid"],
    [{ everyAmount: "0x10" }, "everyAmount", "cron.errors.everyAmountInvalid"],
    [
      {
        everyAmount: "29.999",
        everyUnit: "seconds",
        triggerEnabled: true,
        triggerScript: "json({ fire: true })",
      },
      "everyAmount",
      "cron.errors.triggerIntervalTooShort",
    ],
    [
      { failureAlertMode: "custom", failureAlertAfter: ".5" },
      "failureAlertAfter",
      "Failure alert threshold must be at least 1.",
    ],
    [
      { failureAlertMode: "custom", failureAlertCooldownSeconds: "1e308" },
      "failureAlertCooldownSeconds",
      "Cooldown must be finite and 0 or greater.",
    ],
  ])("rejects invalid numeric input %j before RPC", async (form, field, error) => {
    const { state, request } = createCronSubmitHarness("invalid", {
      form: { name: "Invalid duration", payloadText: "run", ...form },
    });
    expect(await addCronJob(state)).toEqual({ saved: false });
    expect(state.cronFieldErrors).toHaveProperty(field, error);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "deny all",
      policy: {
        toolsAllow: [],
        toolsAllowIsDefault: true,
        fallbacks: [],
        allowUnsafeExternalContent: false,
        lightContext: false,
      },
    },
  ] satisfies Array<{
    name: string;
    policy: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>>;
  }>)("clones $name payload policy without its capture marker", async ({ policy }) => {
    const source = createCronJob({
      id: "source",
      name: "Policy source",
      agentId: "writer",
      payload: { kind: "agentTurn", message: "Synthetic task", ...policy },
    });
    const original = structuredClone(source);
    const request = createCronRequest("clone");
    const state = createStateWithRequest(request, { cronJobs: [source], cronAgentId: "main" });
    startCronEdit(state, source);
    startCronClone(state, source);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "clone" });
    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(submitted.name).toBe("Policy source copy");
    expect(submitted.agentId).toBe("writer");
    expect(request.mock.calls.some(([method]) => method === "cron.update")).toBe(false);
    const expected: Extract<CronJob["payload"], { kind: "agentTurn" }> = {
      kind: "agentTurn",
      message: "Synthetic task",
      ...policy,
    };
    delete expected.toolsAllowIsDefault;
    expect(submitted.payload).toEqual(expected);
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
  });

  it.each([
    {
      name: "agent task to system event",
      payload: {
        kind: "agentTurn",
        message: "Original task",
        toolsAllow: ["read"],
        fallbacks: [],
        allowUnsafeExternalContent: true,
        lightContext: false,
      },
      trigger: undefined,
      target: "systemEvent",
    },
    {
      name: "command to new agent task",
      payload: { kind: "command", argv: ["node", "synthetic.mjs"], toolsAllow: [] },
      trigger: { script: "return { fire: true }", once: false },
      target: "agentTurn",
    },
  ] satisfies Array<{
    name: string;
    payload: CronJob["payload"];
    trigger: CronJob["trigger"];
    target: "agentTurn" | "systemEvent";
  }>)("clone payload policy: retains common restrictions for $name", async (scenario) => {
    const source = createCronJob({
      id: "kind-source",
      name: "Kind transition source",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: scenario.payload,
      trigger: scenario.trigger,
    });
    const original = structuredClone(source);
    const request = createCronRequest("kind-clone");
    const state = createStateWithRequest(request, { cronJobs: [source] });
    startCronClone(state, source);
    if (scenario.payload.kind === "command") {
      expect(state.cronForm.payloadText).toBe("");
      expect(await addCronJob(state)).toEqual({ saved: false });
      expect(state.cronFieldErrors.payloadText).toBe("cron.errors.agentMessageRequired");
      expect(request).not.toHaveBeenCalled();
    }
    Object.assign(state.cronForm, {
      payloadKind: scenario.target,
      sessionTarget: scenario.target === "systemEvent" ? "main" : "isolated",
      payloadText: "New operator-authored task",
    });

    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "kind-clone" });

    const submitted = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
    expect(validateCronAddParams(submitted)).toBe(true);
    expect(source).toEqual(original);
    expect(submitted.trigger).toEqual(scenario.trigger);
    expect(submitted.payload).toEqual({
      kind: scenario.target,
      ...(scenario.target === "systemEvent"
        ? { text: "New operator-authored task" }
        : { message: "New operator-authored task" }),
      toolsAllow: scenario.payload.toolsAllow,
    });
  });

  it("omits hidden payload policy from updates so the Gateway retains authority", async () => {
    const source = createCronJob({
      id: "policy-update",
      name: "Policy update",
      payload: {
        kind: "agentTurn",
        message: "Synthetic task",
        toolsAllow: ["read"],
        toolsAllowIsDefault: true,
        fallbacks: [],
        allowUnsafeExternalContent: true,
        lightContext: false,
      },
    });
    const original = structuredClone(source);
    const { state, submit } = createCronEditHarness(source);
    state.cronForm.description = "Metadata changed";
    const call = await submit();
    expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
    expect(source).toEqual(original);
    expect(requestPatch(call).payload).toEqual({
      kind: "agentTurn",
      message: "Synthetic task",
      lightContext: false,
    });
  });

  it.each([
    {
      name: "minute cron stagger",
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 60_000 },
    },
    { name: "process exit", schedule: { kind: "on-exit", command: "make build", cwd: "/repo" } },
  ] as const)("clones the exact $name schedule while its fields remain unchanged", async (item) => {
    const request = createCronRequest("job-schedule-clone");
    const sourceJob = createCronJob({
      id: "job-schedule-source",
      name: "Source schedule",
      schedule: item.schedule,
    });
    const state = createStateWithRequest(request, { cronJobs: [sourceJob] });

    startCronClone(state, sourceJob);
    expect(await addCronJob(state)).toEqual({ saved: true, jobId: "job-schedule-clone" });

    expect(requestPayload(findRequestCall(request.mock.calls, "cron.add")).schedule).toEqual(
      item.schedule,
    );
  });

  it("round-trips hidden delivery destinations through clone and edit", async () => {
    const sourceJob = createCronJob({
      id: "job-routing",
      name: "Routed job",
      sessionKey: "agent:ops:main",
      delivery: {
        mode: "announce",
        accountId: "ops-bot",
        threadId: 42,
        bestEffort: true,
        completionDestination: { mode: "webhook", to: "https://example.test/complete" },
        failureDestination: {
          mode: "announce",
          channel: "telegram",
          to: "ops",
          accountId: "alerts",
        },
      },
    });

    const addRequest = createCronRequest("job-copy");
    const cloneState = createStateWithRequest(addRequest, { cronJobs: [sourceJob] });
    startCronClone(cloneState, sourceJob);
    await addCronJob(cloneState);
    const addPayload = requestPayload(findRequestCall(addRequest.mock.calls, "cron.add"));
    expect(addPayload.delivery).toEqual(sourceJob.delivery);
    expect(addPayload.sessionKey).toBe("agent:ops:main");
    expect(validateCronAddParams(addPayload)).toBe(true);

    const updateRequest = createCronRequest(sourceJob.id, { existing: true });
    const editState = createStateWithRequest(updateRequest, { cronJobs: [sourceJob] });
    startCronEdit(editState, sourceJob);
    editState.cronForm.deliveryThreadId = "thread-42";
    await addCronJob(editState);
    const updatePayload = requestPayload(findRequestCall(updateRequest.mock.calls, "cron.update"));
    expect(requireRecord(updatePayload.patch, "cron.update patch").delivery).toEqual({
      ...sourceJob.delivery,
      threadId: "thread-42",
    });
    expect(validateCronUpdateParams(updatePayload)).toBe(true);
  });
});

it("reads intervals into the largest exact unit without rounding", () => {
  for (const [everyMs, amount, unit] of [
    [1, "0.001", "seconds"],
    [60_000, "1", "minutes"],
    [7_200_000, "2", "hours"],
    [86_400_000, "1", "days"],
    [8_639_999_999_999_999, "8639999999999.999", "seconds"],
  ] as const) {
    const state = createState();
    startCronEdit(
      state,
      createCronJob({ id: "interval", name: "Interval", schedule: { kind: "every", everyMs } }),
    );
    expect(state.cronForm.everyUnit).toBe(unit);
    expect(state.cronForm.everyAmount).toBe(amount);
    expect(parseCronDurationMs(state.cronForm.everyAmount, state.cronForm.everyUnit)).toBe(everyMs);
  }
});

it("omits an unchanged minute but sends a genuinely changed minute", async () => {
  const originalAt = "2030-01-02T03:04:56.789Z";
  const original = createCronJob({
    id: "job-at-precision",
    name: "Precise one-shot",
    schedule: { kind: "at", at: originalAt },
    deleteAfterRun: true,
  });

  const unchanged = createCronEditHarness(original);
  unchanged.state.cronForm.description = "metadata only";
  const unchangedPatch = requestPatch(await unchanged.submit());
  expect(unchangedPatch).not.toHaveProperty("schedule");

  const changed = createCronEditHarness(original);
  const originalMinute = new Date(originalAt);
  originalMinute.setMinutes(originalMinute.getMinutes() + 1);
  originalMinute.setSeconds(0, 0);
  const year = originalMinute.getFullYear();
  const month = String(originalMinute.getMonth() + 1).padStart(2, "0");
  const day = String(originalMinute.getDate()).padStart(2, "0");
  const hour = String(originalMinute.getHours()).padStart(2, "0");
  const minute = String(originalMinute.getMinutes()).padStart(2, "0");
  changed.state.cronForm.scheduleAt = `${year}-${month}-${day}T${hour}:${minute}`;
  const changedPatch = requestPatch(await changed.submit());
  expect(changedPatch.schedule).toEqual({
    kind: "at",
    at: originalMinute.toISOString(),
  });
});

it("loads independent totals and next wake time for the selected agent", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ jobs: [], total: 7 })
    .mockResolvedValueOnce({ jobs: [{ state: { nextRunAtMs: 1234 } }], total: 1 });
  const state = createStateWithRequest(request, { cronAgentId: "writer" });
  await loadCronScopeStats(state);
  expect(state).toMatchObject({ cronScopedTotal: 7, cronScopedNextWakeAtMs: 1234 });
  expect(request).toHaveBeenNthCalledWith(
    1,
    "cron.list",
    expect.objectContaining({ agentId: "writer", includeDisabled: true }),
  );
});

describe("failure alert form round trips", () => {
  it.each([
    {
      name: "explicit",
      policy: {
        after: 4,
        cooldownMs: 1_001,
        mode: "webhook",
        to: "https://alerts.example.test/cron",
        accountId: "bot-a",
        includeSkipped: true,
      },
    },
    { name: "implicit destination", policy: { channel: "last", includeSkipped: false } },
    { name: "disabled", policy: false },
  ] satisfies Array<{ name: string; policy: CronJob["failureAlert"] }>)(
    "clones the $name failure policy",
    async ({ policy }) => {
      const job = createCronJob({ id: "policy", name: "Policy", failureAlert: policy });
      const request = createCronRequest("clone");
      const state = createStateWithRequest(request);
      startCronClone(state, job);
      await addCronJob(state);
      const payload = requestPayload(findRequestCall(request.mock.calls, "cron.add"));
      expect(validateCronAddParams(payload)).toBe(true);
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- verify omitted fields on the wire
      expect(JSON.parse(JSON.stringify(payload.failureAlert))).toEqual(policy);
    },
  );

  it.each([
    { cooldownMs: 0, seconds: "0" },
    { cooldownMs: Number.MAX_SAFE_INTEGER, seconds: "9007199254740.991" },
  ])(
    "preserves a $cooldownMs ms cooldown when editing metadata",
    async ({ cooldownMs, seconds }) => {
      const job = createCronJob({
        id: "cooldown-metadata",
        name: "Stored cooldown",
        failureAlert: {
          after: 4,
          cooldownMs,
          mode: "webhook",
          to: "https://alerts.example.test/cron",
        },
      });
      const { state, submit } = createCronEditHarness(job);

      expect(state.cronForm.failureAlertCooldownSeconds).toBe(seconds);
      state.cronForm.description = "Only the description changed";
      const call = await submit();

      expect(validateCronUpdateParams(requestPayload(call))).toBe(true);
      expect(requestPatch(call).failureAlert).toMatchObject({
        cooldownMs,
      });
    },
  );

  it.each([["1e-3", 1]] as const)("serializes cooldown seconds %s", async (seconds, cooldownMs) => {
    const { call } = await createCronSubmitHarness("cooldown", {
      form: {
        name: "Cooldown",
        payloadText: "run",
        failureAlertMode: "custom",
        failureAlertCooldownSeconds: seconds,
      },
    }).submit();
    expect(validateCronAddParams(requestPayload(call))).toBe(true);
    expect(requestPayload(call).failureAlert).toMatchObject({ cooldownMs });
  });

  it("preserves inherited alert fields while editing a command with hidden alert controls", async () => {
    const job = createCronJob({
      id: "command-inherited-policy",
      name: "Command alert policy",
      payload: { kind: "command", argv: ["node", "report.mjs"] },
      failureAlert: {},
    });
    const { state, submit } = createCronEditHarness(job);
    state.cronForm.description = "Only metadata changed";

    const call = await submit();

    expect(requestPatch(call)).not.toHaveProperty("payload");
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- hidden controls must not materialize defaults on the wire
    expect(JSON.parse(JSON.stringify(requestPatch(call).failureAlert))).toEqual({});
  });
});
