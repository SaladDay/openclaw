import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressMonitorLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { matrixSyncResponse, useSyncStoreFixture } from "../client/sync-store.test-support.js";
import { MatrixClient, type MatrixRawEvent } from "../sdk.js";
import { createMatrixCryptoFacade } from "../sdk/crypto-facade.js";
import { matrixEventToRaw } from "../sdk/event-helpers.js";
import { MatrixRecoveryKeyStore } from "../sdk/recovery-key-store.js";
import { MatrixVerificationManager } from "../sdk/verification-manager.js";
import { createMatrixIngressMonitor } from "./ingress.js";

describe("Matrix sync admission", () => {
  const storage = useSyncStoreFixture("openclaw-matrix-ingress-");

  it("filters first-login history only, preserving raw replay and left-room events", async () => {
    const queue = createChannelIngressQueueForTests<{
      version: 1;
      roomId: string;
      event: MatrixRawEvent;
    }>({ channelId: "matrix", accountId: "default", stateDir: storage.root });
    const roomId = "!room:example.org";
    const event = {
      event_id: "$ciphertext",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      origin_server_ts: 1_000,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "encrypted-fixture" },
    } satisfies MatrixRawEvent;
    const sync = matrixSyncResponse("cursor", roomId, event, "previous");
    const monitor = createMatrixIngressMonitor({
      accountId: "default",
      client: new MatrixClient("https://example.org", "synthetic-token"),
      startupMs: 2_000,
      queue,
      dispatch: async () => {
        throw new Error("Admission must not dispatch before the monitor starts");
      },
    });
    try {
      await monitor.admitSync(sync, { hasSavedSync: false });
      expect(await queue.listPending()).toEqual([]);

      sync.rooms.leave = {
        "!left:example.org": {
          state: { events: [] },
          timeline: {
            events: [{ ...event, event_id: "$left", type: "m.room.message" }],
            prev_batch: "left-previous",
          },
          account_data: { events: [] },
        },
      };
      await monitor.admitSync(sync, { hasSavedSync: true });
      await monitor.admitSync(sync, { hasSavedSync: true });
      expect(await queue.listPending()).toMatchObject([
        {
          id: "$ciphertext",
          laneKey: `room:${roomId}`,
          payload: { version: 1, roomId, event: { ...event, room_id: roomId } },
        },
        {
          id: "$left",
          laneKey: "room:!left:example.org",
          payload: { event: { event_id: "$left" } },
        },
      ]);
    } finally {
      await monitor.stop();
    }
  });

  it("retains failed decryption for a later successful retry and adopts only once", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const queue = createChannelIngressQueueForTests<{
      version: 1;
      roomId: string;
      event: MatrixRawEvent;
    }>({ channelId: "matrix", accountId: "default", stateDir: storage.root });
    const roomId = "!encrypted:example.org";
    const event = {
      event_id: "$retry-decryption",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      origin_server_ts: now,
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "encrypted-fixture" },
    } satisfies MatrixRawEvent;
    const client = new MatrixClient("https://example.org", "synthetic-token");
    client.crypto = createMatrixCryptoFacade({
      client: { getCrypto: () => undefined, getUserId: () => null },
      verificationManager: new MatrixVerificationManager(),
      recoveryKeyStore: new MatrixRecoveryKeyStore(),
      isRoomEncrypted: async () => true,
      downloadContent: async () => Buffer.alloc(0),
    });
    const failed = new MatrixEvent({
      ...event,
      type: "m.room.message",
      content: { msgtype: "m.bad.encrypted", body: "Synthetic missing room key" },
    });
    vi.spyOn(failed, "isDecryptionFailure").mockReturnValue(true);
    const hydrate = vi.spyOn(client, "hydrateEvents").mockResolvedValue([matrixEventToRaw(failed)]);
    const dispatch = vi.fn(
      async (_room: string, _event: MatrixRawEvent, lifecycle: ChannelIngressMonitorLifecycle) => {
        await lifecycle.onAdopted();
      },
    );
    const params = { accountId: "default", client, startupMs: now, queue, dispatch };
    const first = createMatrixIngressMonitor(params);
    try {
      await first.admitSync(matrixSyncResponse("cursor", roomId, event, "previous"), {
        hasSavedSync: true,
      });
      first.start();
      await first.waitForIdle();
      expect(dispatch).not.toHaveBeenCalled();
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending()).toMatchObject([
        { id: event.event_id, payload: { event }, attempts: 1 },
      ]);
    } finally {
      await first.stop();
    }

    const clear = matrixEventToRaw(
      new MatrixEvent({
        ...event,
        type: "m.room.message",
        content: { msgtype: "m.text", body: "Decrypted fixture" },
      }),
    );
    hydrate.mockResolvedValue([clear]);
    clock.mockReturnValue(now + 2_000);
    const retry = createMatrixIngressMonitor(params);
    try {
      retry.start();
      await retry.waitForIdle();
      await retry.admitSync(matrixSyncResponse("replay", roomId, event, "previous"), {
        hasSavedSync: true,
      });
      await retry.waitForIdle();
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(roomId, clear, expect.any(Object));
      expect(hydrate).toHaveBeenCalledTimes(2);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listClaims()).toEqual([]);
    } finally {
      await retry.stop();
    }
  });
});
