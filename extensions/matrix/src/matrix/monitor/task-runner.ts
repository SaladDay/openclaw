import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";

const monitorTaskSignal = new AsyncLocalStorage<AbortSignal>();
const MATRIX_MONITOR_IDLE_TIMEOUT_MS = 30_000;

export function getMatrixMonitorTaskSignal(): AbortSignal | undefined {
  return monitorTaskSignal.getStore();
}

export function createMatrixMonitorTaskRunner(params: {
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
}) {
  const inFlight = new Set<Promise<void>>();
  const shutdownController = new AbortController();
  let closed = false;

  const runTask = (task: () => Promise<void>): Promise<void> => {
    if (closed) {
      return Promise.reject(new Error("Matrix monitor is stopped"));
    }
    // Retained descendants keep the runner's shutdown signal after their task settles.
    const taskPromise = monitorTaskSignal.run(shutdownController.signal, () =>
      Promise.resolve().then(task),
    );
    const observed = taskPromise.catch(() => {}).finally(() => inFlight.delete(observed));
    inFlight.add(observed);
    return taskPromise;
  };

  const runDetachedTask = (label: string, task: () => Promise<void>): Promise<void> => {
    if (closed) {
      return Promise.resolve();
    }
    return runTask(task).catch((error: unknown) => {
      const message = String(error);
      params.logVerboseMessage(`matrix: ${label} failed (${message})`);
      params.logger.warn("matrix background task failed", { task: label, error: message });
    });
  };

  const waitForIdle = async (): Promise<void> => {
    // The window resets when a task settles. A hung join must not block shutdown.
    while (inFlight.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        new Promise<true>((resolve) => {
          timer = setTimeout(() => resolve(true), MATRIX_MONITOR_IDLE_TIMEOUT_MS);
          timer.unref();
        }),
        ...inFlight,
      ]);
      clearTimeout(timer);
      if (timedOut) {
        shutdownController.abort();
        params.logger.warn("matrix waitForIdle timed out", {
          idleTimeoutMs: MATRIX_MONITOR_IDLE_TIMEOUT_MS,
          remaining: inFlight.size,
        });
        return;
      }
    }
  };

  return {
    close: () => {
      closed = true;
      shutdownController.abort();
    },
    runTask,
    runDetachedTask,
    waitForIdle,
  };
}
