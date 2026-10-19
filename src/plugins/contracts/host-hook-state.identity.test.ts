import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolvePromptBuildHookResult } from "../../agents/embedded-agent-runner/run/attempt-prompt-helpers.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly as readEntry,
  replaceSessionEntry,
  resolveSessionEntryAccessTarget,
} from "../../config/sessions/session-accessor.entry.js";
import { SessionCanonicalKeyMigrationRequiredError } from "../../config/sessions/session-canonical-row.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  drainPluginNextTurnInjectionContext as drain,
  enqueuePluginNextTurnInjection,
} from "../host-hook-state.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

describe("next-turn injection identity", () => {
  let state: OpenClawTestState;
  function sessionScope(cfg: OpenClawConfig, agentId: string, sessionKey: string) {
    return {
      agentId,
      sessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId, env: state.env }),
    };
  }
  async function seed(
    cfg: OpenClawConfig,
    scope: ReturnType<typeof sessionScope>,
    sessionId: string,
    text: string,
  ) {
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    await enqueuePluginNextTurnInjection({
      cfg,
      pluginId: "owner-fixture",
      injection: { ...scope, text },
    });
  }
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "host-hook-identity-" });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "owner-fixture", status: "loaded" }));
    setActivePluginRegistry(registry);
  });
  afterEach(async () => {
    await clearActivePluginRegistry();
    await state.cleanup();
  });

  it.each(["agent:main:missing", "agent:main:dashboard:incognito-injection"])(
    "keeps an absent queue absent and reads a later enqueue for %s",
    async (sessionKey) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {}, unrelated: {} } } };
      const scope = sessionScope(cfg, "main", sessionKey);
      await expect(drain({ cfg, ...scope })).resolves.toMatchObject({
        queuedInjections: [],
      });
      expect(readEntry(scope)).toBeUndefined();
      await seed(cfg, scope, "injection-owner", "next turn");
      await expect(drain({ cfg, ...scope })).resolves.toMatchObject({
        prependContext: "next turn",
      });
      expect(readEntry(scope)?.pluginNextTurnInjections).toBeUndefined();
    },
  );

  it("validates only the selected injection row beside a noncanonical sibling", async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const scope = sessionScope(cfg, "main", "agent:main:healthy");
    const sibling = "agent:main:matrix:channel:!mixed:example.org";
    await replaceSessionEntry(scope, { sessionId: "healthy", updatedAt: 1 });
    await replaceSessionEntry(
      { ...scope, sessionKey: sibling },
      { sessionId: sibling, updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
      JSON.stringify({
        sessionId: sibling,
        updatedAt: 1,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "matrix", to: "!Mixed:example.org" },
        }),
      }),
      sibling,
    );
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(sibling);
    expect(resolveSessionEntryAccessTarget({ cfg, ...scope }).entry?.sessionId).toBe("healthy");
    await expect(drain({ cfg, ...scope })).resolves.toMatchObject({
      queuedInjections: [],
    });
    const broken = { cfg, ...scope, sessionKey: sibling };
    expect(() => resolveSessionEntryAccessTarget(broken)).toThrow(
      SessionCanonicalKeyMigrationRequiredError,
    );
    await expect(drain(broken)).rejects.toBeInstanceOf(SessionCanonicalKeyMigrationRequiredError);
  });

  it.each(["absent", "empty"] as const)(
    "builds ordinary prompts when the selected queue is %s beside a populated colliding row",
    async (queue) => {
      const cfg: OpenClawConfig = {
        session: { store: state.path("{agentId}", "sessions.json"), scope: "global" },
        agents: { entries: { qa: {} } },
      };
      const raw = sessionScope(cfg, "qa", "global");
      const literal = { ...raw, sessionKey: "agent:qa:global" };
      await replaceSessionEntry(raw, {
        sessionId: "raw-owner",
        updatedAt: 1,
        ...(queue === "empty" ? { pluginNextTurnInjections: {} } : {}),
      });
      await seed(cfg, literal, "literal-owner", "literal queue");
      const before = [raw, literal].map((scope) => readEntry(scope));

      const sql = observeHostDataSql();
      try {
        await expect(
          resolvePromptBuildHookResult({
            config: cfg,
            prompt: "Hello",
            messages: [],
            hookCtx: { agentId: "qa", sessionKey: "global" },
          }),
        ).resolves.toMatchObject({ prependContext: undefined, appendContext: undefined });
        expect(
          sql.queries.filter((query) => /\bsession_(?:nodes|windows|participants)\b/.test(query)),
        ).toEqual([]);
      } finally {
        sql.restore();
      }

      expect([raw, literal].map((scope) => readEntry(scope))).toEqual(before);
    },
  );

  it.each([false, true])(
    "preserves the recorded shared-store owner's queue when retired=%s",
    async (retired) => {
      const shared = state.path("shared.sqlite");
      const activeCfg: OpenClawConfig = {
        session: { store: shared, scope: "global" },
        agents: {
          entries: { work: {}, ops: {}, storage: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
      };
      const physical = (sessionKey: string) => ({
        agentId: "ops",
        defaultAgentId: "storage",
        storePath: shared,
        sessionKey,
      });
      for (const sessionKey of ["global", "unknown"]) {
        await seed(activeCfg, physical(sessionKey), `ops-${sessionKey}`, `ops ${sessionKey}`);
      }
      const selected = await resolveSessionEntryAccessTarget(
        { cfg: activeCfg, sessionKey: "global" },
        { keyFormat: "agent-qualified" },
      );
      expect(selected).toMatchObject({
        agentId: "ops",
        canonicalKey: "agent:ops:global",
        storeKey: "global",
        readSource: { agentId: "storage", path: shared },
      });
      const before = ["global", "unknown"].map((key) => readEntry(physical(key)));
      const cfg: OpenClawConfig = retired
        ? {
            ...activeCfg,
            agents: { ...activeCfg.agents, entries: { work: {}, storage: {} } },
          }
        : activeCfg;
      for (const request of [
        { sessionKey: "global", agentId: "work" },
        { sessionKey: "unknown", agentId: "work" },
        { sessionKey: "main", agentId: "work" },
        { sessionKey: "agent:work:main", agentId: "work" },
        { sessionKey: "agent:work:main" },
      ]) {
        await expect(drain({ cfg, ...request })).rejects.toThrow(
          retired ? 'belongs to retired agent "ops"' : 'belongs to "ops", not "work"',
        );
      }
      expect(["global", "unknown"].map((key) => readEntry(physical(key)))).toEqual(before);
      await expect(drain({ cfg: activeCfg, sessionKey: "global" })).resolves.toMatchObject({
        prependContext: "ops global",
      });
      expect(readEntry(physical("global"))?.pluginNextTurnInjections).toBeUndefined();
      expect(readEntry(physical("unknown"))).toEqual(before[1]);
      expect(readEntry({ ...physical("agent:work:global"), agentId: "work" })).toBeUndefined();
    },
  );

  it.each([false, true])(
    "drains the original raw owner without rewriting it when collision=%s",
    async (collision) => {
      const cfg: OpenClawConfig = {
        session: { store: state.path("{agentId}", "sessions.json"), scope: "global" },
        agents: { entries: { qa: {}, beta: {} } },
      };
      const scope = (agentId: string) => sessionScope(cfg, agentId, "global");
      for (const agentId of ["qa", "beta"]) {
        await seed(cfg, scope(agentId), agentId, agentId);
      }
      const betaBefore = readEntry(scope("beta"));
      const literal = { ...scope("qa"), sessionKey: "agent:qa:global" };
      if (collision) {
        await replaceSessionEntry(literal, { sessionId: "separate-literal", updatedAt: 1 });
      }
      await expect(drain({ cfg, agentId: "qa", sessionKey: "global" })).resolves.toMatchObject({
        prependContext: "qa",
      });
      expect(readEntry(scope("qa"))?.pluginNextTurnInjections).toBeUndefined();
      expect(readEntry(literal)?.sessionId).toBe(collision ? "separate-literal" : undefined);
      expect(readEntry(scope("beta"))).toEqual(betaBefore);
    },
  );
});
