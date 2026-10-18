/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionsProcessesListResult } from "../../../../../packages/gateway-protocol/src/schema/session-processes.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestSessionCapability } from "../../../lib/sessions/session-capability.test-support.ts";
import { disposeSidebarContextLifecycles } from "../../../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createGatewayHarness } from "../../../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import "./chat-processes-panel.tsx";

it.each([false, true])(
  "distinguishes a retired process from an incomplete list (truncated: %s)",
  async (truncated) => {
    vi.useFakeTimers();
    let result: SessionsProcessesListResult = {
      sessionId: "parent-session",
      truncated: false,
      processes: [
        {
          processId: "build",
          instanceId: "build-instance",
          name: "Build app",
          status: "running",
          startedAt: 1,
          tail: "Compiling",
          truncated: false,
          canStop: false,
        },
      ],
    };
    const client = createTestGatewayClient(() => result);
    const connection = createGatewayHarness(client);
    connection.publish({
      hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
    });
    const sessions = createTestSessionCapability(connection.gateway);
    const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
    const panel = document.createElement("openclaw-chat-processes-panel");
    panel.sessionKey = "agent:main:parent";
    provider.append(panel);
    document.body.append(provider);
    onTestFinished(() => {
      provider.remove();
      sessions.dispose();
      disposeSidebarContextLifecycles();
      vi.useRealTimers();
    });
    await panel.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await panel.updateComplete;
    panel.querySelector<HTMLButtonElement>(".chat-processes__open")!.click();
    await panel.updateComplete;
    expect(panel.textContent).toContain("Compiling");
    result = { ...result, processes: [{ ...result.processes[0]!, tail: "" }] };
    await vi.advanceTimersByTimeAsync(5_000);
    await panel.updateComplete;
    expect(panel.querySelector(".chat-processes__output-empty")?.textContent).toContain(
      "No output yet",
    );
    expect(
      panel.querySelector(".chat-processes__output-empty .empty-state__icon svg"),
    ).not.toBeNull();
    result = { sessionId: "parent-session", processes: [], truncated };
    await vi.advanceTimersByTimeAsync(5_000);
    await panel.updateComplete;
    if (truncated) {
      expect(panel.textContent).toContain("limited list");
      expect(panel.textContent).not.toContain("no longer retained");
    } else {
      expect(panel.textContent).toContain("no longer retained");
    }
    panel.querySelector<HTMLButtonElement>('button[aria-label="Back to Processes"]')!.click();
    await panel.updateComplete;
    expect(panel.querySelector(".chat-processes__list")?.textContent).toContain("No processes");
    expect(panel.querySelector(".chat-processes__list .empty-state__icon svg")).not.toBeNull();
  },
);

it("keeps Stop separate from opening output and restores list focus after returning", async () => {
  vi.useFakeTimers();
  const stopped = createDeferred<{ requested: boolean }>();
  let result: SessionsProcessesListResult = {
    sessionId: "parent-session",
    truncated: false,
    processes: [
      {
        processId: "build",
        instanceId: "build-instance",
        name: "Build app",
        status: "running",
        startedAt: 1,
        tail: "Compiling\nReady",
        truncated: false,
        canStop: true,
      },
    ],
  };
  const request = vi.fn((method: string) =>
    method === "sessions.processes.stop" ? stopped.promise : result,
  );
  const client = createTestGatewayClient(request);
  const connection = createGatewayHarness(client);
  connection.publish({
    hello: gatewayHelloForMethods(["sessions.processes.list", "sessions.processes.stop"]),
  });
  const sessions = createTestSessionCapability(connection.gateway);
  const provider = createApplicationContextProvider(createContext(connection.gateway, sessions));
  const panel = document.createElement("openclaw-chat-processes-panel");
  panel.sessionKey = "agent:main:parent";
  panel.mobile = true;
  provider.append(panel);
  document.body.append(provider);
  onTestFinished(() => {
    provider.remove();
    sessions.dispose();
    disposeSidebarContextLifecycles();
    vi.useRealTimers();
  });
  await panel.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
  const list = panel.querySelector<HTMLDivElement>(".chat-processes__list")!;
  list.scrollTop = 55;
  const opener = panel.querySelector<HTMLButtonElement>('button[aria-label="Build app"]')!;
  const stop = panel.querySelector<HTMLButtonElement>('button[aria-label="Stop Build app"]')!;
  stop.click();
  await panel.updateComplete;
  expect(request).toHaveBeenCalledWith("sessions.processes.stop", {
    key: "agent:main:parent",
    agentId: "main",
    sessionId: "parent-session",
    processId: "build",
    instanceId: "build-instance",
  });
  expect(stop.disabled).toBe(true);
  expect(list.hidden).toBe(false);
  opener.click();
  await panel.updateComplete;
  expect(panel.querySelector("pre")?.textContent).toBe("Compiling\nReady");
  const detailStop = panel.querySelector<HTMLButtonElement>(
    '.chat-processes__detail button[aria-label="Stop Build app"]',
  )!;
  expect(detailStop.disabled).toBe(true);
  result = {
    ...result,
    processes: [{ ...result.processes[0]!, status: "killed", endedAt: 5000, canStop: false }],
  };
  stopped.resolve({ requested: true });
  await vi.advanceTimersByTimeAsync(0);
  await panel.updateComplete;
  expect(
    panel.querySelector('.chat-processes__detail button[aria-label="Stop Build app"]'),
  ).toBeNull();
  panel.querySelector<HTMLButtonElement>('button[aria-label="Back to Processes"]')!.click();
  await panel.updateComplete;
  expect(list.hidden).toBe(false);
  expect(list.scrollTop).toBe(55);
  expect(document.activeElement).toBe(list);
  expect(
    request.mock.calls.filter(([method]) => method === "sessions.processes.stop"),
  ).toHaveLength(1);
});
