import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "../auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "../model-auth-availability.js";
import { prepareAgentRuntimeAuth } from "./prepare-auth.js";

function authStore(apiKeyProfile: string, oauthProfile: string): AuthProfileStore {
  return createAuthProfileStoreFixture({
    [apiKeyProfile]: createApiKeyCredential("openai", "fixture-key"),
    [oauthProfile]: createOAuthRefreshCredential({
      access: "fixture-access",
      refresh: "fixture-refresh",
    }),
  });
}

function billingConfig(primary: string, apiProfile: string, oauthProfile: string): OpenClawConfig {
  return {
    agents: { defaults: { model: primary, heartbeat: { model: "openai/gpt-5.4-mini" } } },
    auth: {
      profiles: {
        [apiProfile]: { provider: "openai", mode: "api_key" },
        [oauthProfile]: { provider: "openai", mode: "oauth" },
      },
    },
    models: {
      providers: {
        openai: { api: "openai-completions", baseUrl: "https://api.openai.com/v1", models: [] },
      },
    },
  };
}
type PrepareParams = Parameters<typeof prepareAgentRuntimeAuth>[0];
function underAmbient(
  snapshot: Parameters<typeof withPluginMetadataSnapshotScope>[0],
  params: PrepareParams,
) {
  return withPluginMetadataSnapshotScope(snapshot, () => prepareAgentRuntimeAuth(params), {
    config: params.config,
    trustConfigIdentity: true,
  });
}

describe("prepared primary route inheritance", () => {
  it.each([
    { primary: "metered@openai:platform", runtime: "codex" },
    { primary: "gpt-5.5@openai:platform", runtime: "openclaw", profileMetadata: false },
    {
      primary: "metered@openai:platform",
      runtime: "codex",
      profileMetadata: false,
      observedResponses: true,
    },
  ])(
    "preserves the API route inherited from $primary (metadata: $profileMetadata)",
    ({ primary, runtime, profileMetadata, observedResponses }) => {
      const config = billingConfig(primary, "openai:platform", "openai:chatgpt");
      config.agents = {
        entries: { assistant: {} },
        defaults: {
          ...config.agents?.defaults,
          models: { "openai/gpt-5.5": { alias: "metered", agentRuntime: { id: runtime } } },
        },
      };
      if (profileMetadata === false) {
        config.auth = undefined;
      }
      if (observedResponses) {
        config.models = undefined;
      }
      const prepared = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        env: {},
        config,
        agentId: "assistant",
        ...(observedResponses
          ? { modelApi: "openai-responses", modelBaseUrl: "https://api.openai.com/v1" }
          : {}),
        authProfileStore: authStore("openai:platform", "openai:chatgpt"),
      });
      expect(prepared.plan).toMatchObject({
        forwardedAuthProfileId: "openai:platform",
        modelRoute: { authRequirement: "api-key" },
      });
      expect(config.agents?.defaults?.model).toBe(primary);
    },
  );
});

describe("explicit authentication before inherited billing intent", () => {
  it.each(["provider-profile", "auth-order", "env-fallback", "provider-auth-with-env"] as const)(
    "preparation and availability preserve the same billing choice for %s",
    (choice) => {
      const hasEnvironmentKey = choice === "env-fallback" || choice === "provider-auth-with-env";
      const env = hasEnvironmentKey ? { OPENAI_API_KEY: "synthetic-environment-key" } : {};
      const subscription = choice === "env-fallback";
      const expected = {
        profileId: subscription ? "openai:chatgpt-default" : "openai:default",
        authRequirement: subscription ? "subscription" : "api-key",
      };
      const config = billingConfig(
        hasEnvironmentKey ? "openai/gpt-5.5" : "openai/gpt-5.5@openai:chatgpt-default",
        "openai:default",
        "openai:chatgpt-default",
      );
      if (choice === "auth-order") {
        config.auth = {
          ...config.auth,
          order: { openai: ["openai:default", "openai:chatgpt-default"] },
        };
      }
      Object.assign(
        config.models!.providers!.openai!,
        choice === "provider-auth-with-env" ? { auth: "api-key" } : {},
        choice === "provider-profile" ? { apiKey: "openai:default" } : {},
      );
      const store = authStore("openai:default", "openai:chatgpt-default");
      const prepared = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        config,
        authProfileStore: store,
        env,
      }).plan;
      const available = createModelAuthAvailabilityResolver({
        cfg: config,
        authStore: store,
        env,
      }).evaluateModelAuth("openai", { modelId: "gpt-5.4-mini" });
      expect(available.availability).toBe(true);
      expect({
        preparation: {
          profileId: prepared.forwardedAuthProfileId,
          authRequirement: prepared.modelRoute?.authRequirement,
        },
        availability: {
          profileId: available.selectedProfileId,
          authRequirement: available.selectedRoute?.authRequirement,
        },
      }).toEqual({ preparation: expected, availability: expected });
    },
  );
});

function metadata(owner: string) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: owner, providerAuthAliases: { "fixture-alias": owner } }],
  });
}

describe("prepared auth metadata ownership", () => {
  it.each([true, false])("uses selected environment evidence (available: %s)", (available) => {
    const snapshot = (envVar: string) =>
      createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-owner",
            providers: ["fixture-provider"],
            setup: {
              requiresRuntime: false,
              providers: [{ id: "fixture-provider", envVars: [envVar] }],
            },
          },
        ],
      });
    const config = {};
    const prepared = underAmbient(snapshot("AMBIENT_PROVIDER_KEY"), {
      provider: "fixture-provider",
      modelId: "model",
      config,
      env: available
        ? { SELECTED_PROVIDER_KEY: "synthetic" }
        : { AMBIENT_PROVIDER_KEY: "synthetic" },
      metadataSnapshot: snapshot("SELECTED_PROVIDER_KEY"),
      authProfileStore: { version: 1, profiles: {} },
    });

    expect(prepared.attempts[0]?.kind).toBe(available ? "direct" : "implicit");
    expect(prepared.plan.credentialSource).toEqual(
      available
        ? { kind: "direct", evidence: "environment", authorization: "ambient" }
        : { kind: "none" },
    );
  });

  it.each(["user-link", "binding"] as const)(
    "selects the prepared owner for %s profiles despite ambient aliases",
    (selection) => {
      const config: OpenClawConfig =
        selection === "binding"
          ? {
              models: {
                providers: {
                  "fixture-alias": { baseUrl: "", models: [], apiKey: "fixture:selected" },
                },
              },
            }
          : {};
      const prepared = underAmbient(metadata("ambient-auth"), {
        provider: "fixture-alias",
        modelId: "model",
        config,
        env: {},
        metadataSnapshot: metadata("selected-auth"),
        authProfileStore: createAuthProfileStoreFixture({
          "fixture:ambient": createApiKeyCredential("ambient-auth", "synthetic-ambient"),
          "fixture:selected": createApiKeyCredential("selected-auth", "synthetic-selected"),
        }),
        ...(selection === "user-link"
          ? { sessionAuthProfileId: "fixture:selected", sessionAuthProfileSource: selection }
          : {}),
      });

      expect(prepared.plan).toMatchObject({
        providerForAuth: "selected-auth",
        forwardedAuthProfileId: "fixture:selected",
        forwardedAuthProfileCandidateIds: ["fixture:selected"],
      });
      expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["fixture:selected"]);
    },
  );

  it("treats an empty prepared selection as authoritative", () => {
    const config = {};
    const prepared = underAmbient(metadata("ambient-auth"), {
      provider: "fixture-alias",
      modelId: "model",
      config,
      env: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      authProfileStore: createAuthProfileStoreFixture({
        "fixture:exact": createApiKeyCredential("fixture-alias", "synthetic-exact"),
        "fixture:ambient": createApiKeyCredential("ambient-auth", "synthetic-ambient"),
      }),
    });

    expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["fixture:exact"]);
    expect(prepared.plan.forwardedAuthProfileCandidateIds).toEqual(["fixture:exact"]);
  });
});
