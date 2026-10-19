// Idle-eviction under pool pressure: one busy agent must not brick terminal
// opens gateway-wide until restart.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { TerminalSessionManager } from "./session-manager.js";
import {
  agentTerminalOwner,
  baseOpenRequest,
  expectTerminalOpen,
  type FakeTerminalPty,
  makeFakePty,
} from "./session-manager.test-helpers.js";

afterEach(() => vi.useRealTimers());

const agentOwner = agentTerminalOwner("agent:main:main");

function trackingManager(maxSessions: number, spawn = async () => makeFakePty()) {
  const ptys: FakeTerminalPty[] = [];
  const manager = new TerminalSessionManager({
    emit: vi.fn(),
    spawn: async () => {
      const pty = await spawn();
      ptys.push(pty);
      return pty;
    },
    maxSessions,
  });
  const open = (overrides: Parameters<typeof baseOpenRequest>[0] = {}) =>
    manager.open(baseOpenRequest({ owner: agentOwner, ...overrides }));
  return { manager, ptys, open };
}

describe("TerminalSessionManager idle eviction", () => {
  it("never evicts viewer-attached or connection-owned sessions under pressure", async () => {
    const { manager, ptys, open } = trackingManager(2);
    const connOwned = await manager.open(baseOpenRequest());
    const viewed = await open();
    if (!connOwned.ok || !viewed.ok) {
      throw new Error("expected opens");
    }
    expect(manager.attach("viewer-1", viewed.sessionId)?.sessionId).toBe(viewed.sessionId);

    const denied = await open();
    expect(denied).toMatchObject({ ok: false, code: "limit" });
    expect(manager.size).toBe(2);
    expect(ptys.some((pty) => pty.killed)).toBe(false);
  });

  it("spares a victim that gains a viewer during the replacement spawn", async () => {
    const victimPty = makeFakePty();
    const replacementPty = makeFakePty();
    const gate = createDeferred<void>();
    let spawnCount = 0;
    const { manager, open } = trackingManager(1, async () => {
      if (spawnCount++ === 0) {
        return victimPty;
      }
      await gate.promise;
      return replacementPty;
    });
    const victim = expectTerminalOpen(await open());

    const opening = open();
    // The replacement stays gated while the idle victim gains a viewer.
    expect(manager.attach("viewer-1", victim.sessionId)?.sessionId).toBe(victim.sessionId);
    gate.resolve();

    const outcome = await opening;
    expect(outcome).toMatchObject({ ok: false, code: "limit" });
    // The now-viewered session survives; the orphaned replacement is killed.
    expect(victimPty.killed).toBe(false);
    expect(replacementPty.killed).toBe(true);
    expect(manager.size).toBe(1);
    expect(manager.write("viewer-1", victim.sessionId, "still-alive\r")).toBe(true);
  });

  it("evicts the freshly idlest session when the oldest becomes active mid-spawn", async () => {
    vi.useFakeTimers();
    const gate = createDeferred<void>();
    let gateNextSpawn = false;
    const { manager, ptys, open } = trackingManager(2, async () => {
      if (gateNextSpawn) {
        await gate.promise;
      }
      return makeFakePty();
    });
    expectTerminalOpen(await open());
    await vi.advanceTimersByTimeAsync(5_000);
    expectTerminalOpen(await open());

    gateNextSpawn = true;
    const opening = open();
    // The oldest session becomes active during the spawn, making
    // the newer session the genuinely idlest candidate.
    await vi.advanceTimersByTimeAsync(5_000);
    expectDefined(ptys[0], "oldest pty invariant").emitData("busy\n");
    gate.resolve();

    const outcome = await opening;
    expect(outcome.ok).toBe(true);
    expect(manager.size).toBe(2);
    expect(expectDefined(ptys[0], "oldest pty invariant").killed).toBe(false);
    expect(expectDefined(ptys[1], "newer pty invariant").killed).toBe(true);
  });

  it("holds the cap when concurrent opens complete out of order", async () => {
    const gates: Array<(pty: FakeTerminalPty) => void> = [];
    const { manager, open } = trackingManager(2, async () => {
      const pty = await new Promise<FakeTerminalPty>((resolve) => {
        gates.push(resolve);
      });
      return pty;
    });
    const seeded = open();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]?.(makeFakePty());
    const seededOutcome = await seeded;
    expect(seededOutcome.ok).toBe(true);

    // A reserves the free slot; B sees the reservation and an idle eviction
    // candidate. B's spawn completes first.
    const openA = open();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    const openB = open();
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    const excess = open();
    expect(gates).toHaveLength(3);
    await expect(excess).resolves.toMatchObject({ ok: false, code: "limit" });
    gates[2]?.(makeFakePty());
    const outcomeB = await openB;
    gates[1]?.(makeFakePty());
    const outcomeA = await openA;

    expect(outcomeA.ok).toBe(true);
    expect(outcomeB.ok).toBe(true);
    // The hard cap survives the out-of-order completion.
    expect(manager.size).toBeLessThanOrEqual(2);
  });

  it("allows idle eviction after a cancelled open's spawn never settles", async () => {
    let hangNextSpawn = false;
    const { manager, open } = trackingManager(1, async () => {
      if (hangNextSpawn) {
        hangNextSpawn = false;
        return await new Promise<never>(() => {});
      }
      return makeFakePty();
    });
    expectTerminalOpen(await open());
    hangNextSpawn = true;
    const controller = new AbortController();
    const hung = open({ signal: controller.signal });
    await vi.waitFor(() => expect(hangNextSpawn).toBe(false));
    controller.abort(new Error("cancelled"));

    // Cancellation releases capacity, so a later open can evict the victim.
    const next = await open();
    expect(next.ok).toBe(true);
    expect(manager.size).toBe(1);
    // The hung open stays pending forever by design; do not await it.
    void hung;
  });

  it("keeps the idle victim alive when the replacement spawn fails", async () => {
    const pty = makeFakePty();
    let failNextSpawn = false;
    const { manager, open } = trackingManager(1, async () => {
      if (failNextSpawn) {
        throw new Error("pty exhausted");
      }
      return pty;
    });
    const victim = expectTerminalOpen(await open());

    failNextSpawn = true;
    const failed = await open();
    expect(failed).toMatchObject({ ok: false, code: "spawn_failed" });
    // The victim survives a failed replacement and remains eligible for eviction.
    expect(manager.size).toBe(1);
    expect(pty.killed).toBe(false);
    pty.emitData("still-alive\n");
    expect(manager.snapshotAgent(agentOwner, victim.sessionId)).toContain("still-alive");

    failNextSpawn = false;
    const replacement = await open();
    expect(replacement.ok).toBe(true);
    expect(manager.size).toBe(1);
    expect(pty.killed).toBe(true);
  });
});
