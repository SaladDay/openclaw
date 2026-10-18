import { createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import type { UsageSummary } from "../../../../src/infra/provider-usage.types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { renderProviderUsageDetails } from "../../components/solid/provider-usage.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { createTimeout } from "../../lib/reactive/timers.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";

registerEnglishCatalog(registerSettingsEnglish);

type ModelAccountUsageProps = {
  client: GatewayBrowserClient | null;
  agentId: string;
  profileId: string;
};
type ModelAccountUsageMethods = { refreshUsage: () => void };
export type ModelAccountUsageElement = SolidBridgeElement<
  ModelAccountUsageProps,
  ModelAccountUsageMethods
>;
const owners = new WeakMap<
  ModelAccountUsageElement,
  { inputsChanged: () => void; refresh: () => void }
>();

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-model-account-usage": ModelAccountUsageElement;
  }
}

type UsageState =
  | { phase: "idle" | "pending" }
  | { phase: "complete"; summary: UsageSummary }
  | { phase: "error"; error: unknown };

function AccountUsage(props: ModelAccountUsageProps, host: ModelAccountUsageElement) {
  const [state, setState] = createSignal<UsageState>({ phase: "idle" });
  let disposed = false;
  let isCurrent = () => false;
  const request = createPageRequest(() => {}, {
    task: (
      [client, agentId, profileId]: readonly [GatewayBrowserClient, string, string],
      { signal },
    ) =>
      client.request<UsageSummary>(
        "codex.accountUsage",
        { agentId, profileId },
        { signal, timeoutMs: 30_000 },
      ),
    onComplete: (summary) => {
      if (isCurrent()) {
        setState({ phase: "complete", summary });
      }
    },
    onError: (error) => {
      if (isCurrent()) {
        setState({ phase: "error", error });
      }
    },
  });
  async function load(scope: ModelAccountUsageProps): Promise<void> {
    request.cancel();
    if (!scope.client || !scope.agentId || !scope.profileId) {
      setState({ phase: "idle" });
      return;
    }
    isCurrent = () =>
      props.client === scope.client &&
      props.agentId === scope.agentId &&
      props.profileId === scope.profileId;
    setState({ phase: "pending" });
    await request.run([scope.client, scope.agentId, scope.profileId]);
  }

  const scope = () => ({
    client: props.client,
    agentId: props.agentId,
    profileId: props.profileId,
  });
  const deferredLoad = createTimeout(refresh, 0);
  function refresh() {
    deferredLoad.cancel();
    if (!disposed) {
      void load(scope());
    }
  }
  const inputsChanged = () => {
    // Revoke the old request at the native setter, before any deferred rendering or load.
    request.cancel();
    deferredLoad.schedule();
  };
  owners.set(host, { inputsChanged, refresh });
  onCleanup(() => {
    disposed = true;
    owners.delete(host);
    request.cancel();
  });
  onSettled(refresh);
  const summary = createMemo(() => {
    const current = state();
    return current.phase === "complete" ? current.summary : undefined;
  });
  const error = createMemo(() => {
    const current = state();
    return current.phase === "error" ? formatUiError(current.error) : undefined;
  });
  return (
    <Show when={props.client}>
      <div class="model-providers__account-usage">
        <button
          class="model-providers__account-refresh"
          type="button"
          aria-label={t("common.refresh")}
          title={t("common.refresh")}
          disabled={state().phase === "pending"}
          onClick={refresh}
        >
          <Icon name="refresh" />
        </button>
        <Show when={state().phase === "pending"}>
          <span>{t("common.loading")}</span>
        </Show>
        <Show when={summary()}>
          {(value) => (
            <For each={value().providers} fallback={<span>{t("modelProviders.noStats")}</span>}>
              {(snapshot) => (
                <>
                  <Show when={snapshot.plan}>
                    <strong>{snapshot.plan}</strong>
                  </Show>
                  <div>
                    <Show
                      when={snapshot.windows.length || snapshot.billing?.length}
                      fallback={t("modelProviders.noStats")}
                    >
                      {renderProviderUsageDetails(snapshot, { groupWindows: true })}
                    </Show>
                  </div>
                </>
              )}
            </For>
          )}
        </Show>
        <Show when={error()}>
          <span class="provider-usage-error">{error()}</span>
        </Show>
      </div>
    </Show>
  );
}

defineSolidBridge<ModelAccountUsageProps, ModelAccountUsageMethods>(
  "openclaw-model-account-usage",
  (props, host) => AccountUsage(props, host),
  {
    properties: {
      client: { default: null, attribute: false },
      agentId: { default: "" },
      profileId: { default: "" },
    },
    propertyChanged: (host) => owners.get(host)?.inputsChanged(),
    methods: {
      refreshUsage: (host) => owners.get(host)?.refresh(),
    },
  },
);
