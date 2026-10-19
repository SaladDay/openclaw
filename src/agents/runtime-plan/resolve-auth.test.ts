import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { OAuthRefreshFailureError } from "../auth-profiles/oauth-refresh-failure.js";
import type { PreparedAgentRuntimeAuthAttempt } from "./prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
  scopeAuthProfileStoreToPreparedPlan,
} from "./resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

vi.mock("../model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN"] },
    authEvidenceMap: {},
    setupProviderFallbackRefs: [],
  }),
}));

vi.mock("../../llm/oauth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../llm/oauth.js")>()),
  getOAuthApiKey: vi.fn(async () => {
    throw new Error("invalid_grant");
  }),
}));

const platformModel = {
  id: "gpt-5.5",
  name: "gpt-5.5",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_000,
} as Model;

const subscriptionModel = {
  ...platformModel,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as Model;

const platformRoute = {
  provider: "openai",
  modelId: "gpt-5.5",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;

const subscriptionRoute = {
  ...platformRoute,
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
} as const;

function authStore(profiles: AuthProfileStore["profiles"]): AuthProfileStore {
  return { version: 1, profiles };
}

const authProvider = { providerForAuth: "openai", authProfileProviderForAuth: "openai" };
function makeProfilePlan(
  profileId: string,
  candidates = [profileId],
  overrides: Partial<AgentRuntimeAuthPlan> = {},
): AgentRuntimeAuthPlan {
  return {
    ...authProvider,
    forwardedAuthProfileId: profileId,
    forwardedAuthProfileSource: "auto",
    forwardedAuthProfileCandidateIds: candidates,
    ...overrides,
  };
}
function token(value: string) {
  return { type: "token" as const, provider: "openai", token: value, expires: Date.now() + 60_000 };
}
function oauth(access: string, refresh: string, expires = Date.now() + 60_000) {
  return { type: "oauth" as const, provider: "openai", access, refresh, expires };
}
function profileThenDirect(
  plan: AgentRuntimeAuthPlan,
  directPlan: AgentRuntimeAuthPlan,
): PreparedAgentRuntimeAuthAttempt[] {
  if (!plan.forwardedAuthProfileId) {
    throw new Error("expected a profile plan");
  }
  return [
    { kind: "profile", plan, profileId: plan.forwardedAuthProfileId },
    {
      kind: "direct",
      plan: directPlan,
      allowAuthProfileFallback: false,
      requiresPriorProfileAttempt: true,
    },
  ];
}
type ResolveParams = Parameters<typeof resolvePreparedRuntimeModelAuth>[0];
function resolveModelAuth(
  params: Omit<ResolveParams, "model" | "cfg"> & Partial<Pick<ResolveParams, "model" | "cfg">>,
) {
  return resolvePreparedRuntimeModelAuth({ model: platformModel, cfg: {}, ...params });
}
function expectAuth(params: Parameters<typeof resolveModelAuth>[0]) {
  return expect(resolveModelAuth(params));
}

describe("resolvePreparedRuntimeModelAuth", () => {
  aroundEach((runTest) =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "openai", providers: ["openai"] }],
        }),
      },
      runTest,
    ),
  );

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_MISSING_PREPARED_AUTH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes profile and selection state after a Platform key is resolved", () => {
    const store = {
      ...authStore({
        "openai:subscription": token("subscription-token"),
        "openai:platform": createApiKeyCredential("openai", "platform-key"),
      }),
      order: { openai: ["openai:subscription", "openai:platform"] },
      lastGood: { openai: "openai:subscription" },
      usageStats: { "openai:subscription": { lastUsed: 1 } },
      runtimePersistedProfileIds: ["openai:subscription"],
      runtimeExternalProfileIds: ["openai:subscription"],
      runtimeExternalProfileIdsAuthoritative: true,
    } satisfies AuthProfileStore;

    expect(
      scopeAuthProfileStoreToPreparedPlan(store, {
        ...authProvider,
        forwardedAuthProfileId: "openai:platform",
        forwardedAuthProfileCandidateIds: ["openai:platform"],
        selectedAuthMode: "api-key",
        modelRoute: { ...platformRoute, modelId: "gpt-5.6" },
      }),
    ).toMatchObject({
      profiles: {},
      order: { openai: [] },
      lastGood: {},
      usageStats: {},
      runtimePersistedProfileIds: [],
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("preserves the selected renewable OAuth owner through public Responses preparation", async () => {
    const credential = {
      type: "oauth" as const,
      provider: "openai",
      authFlow: "chatgpt-token-sharing",
      access: "shared-access",
      refresh: "shared-refresh",
      expires: Date.now() + 600_000,
    };
    const store = authStore({
      "openai:shared": credential,
      "openai:unselected": { ...credential, access: "unselected-access" },
    });
    const resolved = await resolveModelAuth({
      plan: {
        ...authProvider,
        forwardedAuthProfileId: "openai:shared",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:shared"],
        selectedAuthMode: "oauth",
        selectedAuthFlow: "chatgpt-token-sharing",
        modelRoute: platformRoute,
      },
      store,
    });
    expect(resolved.auth).toMatchObject({
      apiKey: "shared-access",
      mode: "oauth",
      authFlow: "chatgpt-token-sharing",
      profileId: "openai:shared",
    });
    expect(resolved.plan).toMatchObject({
      selectedAuthMode: "oauth",
      selectedAuthFlow: "chatgpt-token-sharing",
    });
    expect(scopeAuthProfileStoreToPreparedPlan(store, resolved.plan).profiles).toEqual({
      "openai:shared": credential,
    });
  });

  it("keeps a failed explicit SecretRef terminal across prepared profile candidates", async () => {
    const store = authStore({
      "openai:missing": {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_PREPARED_AUTH",
        },
      },
      "openai:backup": createApiKeyCredential("openai", "backup-key"),
    });

    await expectAuth({
      plan: makeProfilePlan("openai:missing", ["openai:missing", "openai:backup"], {
        selectedAuthMode: "api_key",
        modelRoute: platformRoute,
      }),
      store,
      secretSentinels: true,
    }).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "account",
    });
  });

  it(
    "does not borrow an unprepared API-key profile for direct subscription auth",
    { timeout: 1_000 },
    async () => {
      vi.stubEnv("OPENAI_API_KEY", "");
      const store = authStore({
        "openai:platform": createApiKeyCredential("openai", "platform-key"),
      });

      await expectAuth({
        plan: {
          ...authProvider,
          selectedAuthMode: "token",
          modelRoute: subscriptionRoute,
        },
        model: subscriptionModel,
        store,
        secretSentinels: true,
      }).rejects.toThrow('No API key found for provider "openai"');
    },
  );

  it("resolves an ambient Platform key without borrowing the OAuth-only full store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-platform-key");
    const store = authStore({
      "openai:chatgpt": oauth("subscription-token", "refresh-token"),
    });

    const resolved = await resolveModelAuth({
      plan: {
        ...authProvider,
        selectedAuthMode: "api-key",
        modelRoute: platformRoute,
      },
      store,
      secretSentinels: true,
    });

    expect(resolved).toMatchObject({
      auth: {
        apiKey: "ambient-platform-key",
        mode: "api-key",
      },
      plan: {
        forwardedAuthProfileId: undefined,
        selectedAuthMode: "api-key",
      },
    });
    expect(resolved.auth.source).toContain("OPENAI_API_KEY");
  });

  it("keeps authored unpinned provider auth ahead of an opposite-route store", async () => {
    const store = authStore({
      "openai:chatgpt": {
        type: "token",
        provider: "openai",
        token: "subscription-token",
      },
    });

    await expectAuth({
      plan: {
        ...authProvider,
        selectedAuthMode: "api-key",
        modelRoute: platformRoute,
      },
      cfg: {
        models: {
          providers: {
            openai: {
              apiKey: "configured-platform-key",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
      },
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({ auth: { mode: "api-key" } });
  });

  it("materializes authored OpenAI oauth without borrowing the API-only full store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const store = authStore({
      "openai:platform": createApiKeyCredential("openai", "platform-key"),
    });
    await expectAuth({
      plan: {
        ...authProvider,
        selectedAuthMode: "oauth",
        modelRoute: subscriptionRoute,
      },
      model: subscriptionModel,
      cfg: {
        models: {
          providers: {
            openai: {
              auth: "oauth",
              apiKey: "configured-subscription-credential",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [],
            },
          },
        },
      },
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: {
        apiKey: "configured-subscription-credential",
        source: "models.json",
        mode: "oauth",
      },
      plan: {
        selectedAuthMode: "oauth",
        modelRoute: { authRequirement: "subscription" },
      },
    });
  });

  it("skips a prepared candidate whose stored credential class changed", async () => {
    const store = authStore({
      "openai:changed": createApiKeyCredential("openai", "platform-key"),
      "openai:backup": token("subscription-token"),
    });

    await expectAuth({
      plan: makeProfilePlan("openai:changed", ["openai:changed", "openai:backup"], {
        selectedAuthMode: "token",
        modelRoute: subscriptionRoute,
      }),
      model: subscriptionModel,
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: { profileId: "openai:backup", mode: "token" },
      plan: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
        selectedAuthMode: "token",
      },
    });
  });

  it("falls through from a stale OAuth automatic candidate to a prepared backup profile", async () => {
    const store = authStore({
      "openai:expired": oauth("expired-access", "expired-refresh", Date.now() - 60_000),
      "openai:backup": createApiKeyCredential("openai", "backup-key"),
    });

    await expectAuth({
      plan: makeProfilePlan("openai:expired", ["openai:expired", "openai:backup"], {
        selectedAuthMode: "api_key",
        modelRoute: platformRoute,
      }),
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: { profileId: "openai:backup", mode: "api-key" },
      plan: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
        selectedAuthMode: "api-key",
      },
    });
  });

  it("skips an automatic candidate that cooled down after plan preparation", async () => {
    const store = authStore({
      "openai:first": createApiKeyCredential("openai", "first-key"),
      "openai:backup": createApiKeyCredential("openai", "backup-key"),
    });
    const plan = makeProfilePlan("openai:first", ["openai:first", "openai:backup"], {
      selectedAuthMode: "api_key",
      modelRoute: platformRoute,
    });
    store.usageStats = {
      "openai:first": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "gpt-5.5",
      },
    };

    await expectAuth({
      plan,
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: { profileId: "openai:backup" },
      plan: {
        forwardedAuthProfileId: "openai:backup",
        forwardedAuthProfileCandidateIds: ["openai:backup"],
      },
    });
  });

  it("fails closed when every prepared automatic candidate is in cooldown", async () => {
    const store = authStore({
      "openai:first": createApiKeyCredential("openai", "first-key"),
      "openai:backup": createApiKeyCredential("openai", "backup-key"),
    });
    store.usageStats = Object.fromEntries(
      ["openai:first", "openai:backup"].map((profileId) => [
        profileId,
        {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit" as const,
          cooldownModel: "gpt-5.5",
        },
      ]),
    );

    await expectAuth({
      plan: makeProfilePlan("openai:first", ["openai:first", "openai:backup"]),
      store,
      secretSentinels: true,
    }).rejects.toThrow("temporarily unavailable");
  });

  it("does not unlock direct fallback when a profile cools during materialization", async () => {
    const store = authStore({
      "openai:first": createApiKeyCredential("openai", "first-key"),
    });
    const profilePlan = makeProfilePlan("openai:first", ["openai:first"]);
    const directPlan = {
      ...authProvider,
    };
    const resolveAuth = vi.fn(async () => ({ plan: directPlan, auth: "unused" }));
    const materializeModel = vi.fn(async () => {
      store.usageStats = {
        "openai:first": { cooldownUntil: Date.now() + 60_000 },
      };
      return platformModel;
    });

    await expect(
      resolvePreparedRuntimeAuthAttempts({
        attempts: profileThenDirect(profilePlan, directPlan),
        store,
        modelId: "gpt-5.5",
        model: platformModel,
        materializeModel,
        resolveAuth,
        errorMessage: "prepared auth failed",
      }),
    ).rejects.toThrow("temporarily unavailable");
    expect(materializeModel).toHaveBeenCalledOnce();
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("does not unlock another prepared attempt after an explicit profile ref fails", async () => {
    const profilePlan = makeProfilePlan("openai:cold", ["openai:cold"]);
    const directPlan = {
      ...authProvider,
    };
    const unavailable = new SecretSurfaceUnavailableError({
      ownerKind: "account",
      ownerId: "openai:cold",
      state: "unavailable",
      paths: ["auth-profiles.openai:cold.key"],
      refKeys: ["env:default:MISSING_OPENAI_KEY"],
      reason: "secret reference was not found",
    });
    const resolveAuth = vi.fn(async ({ attempt }: { attempt: { kind: string } }) => {
      if (attempt.kind === "profile") {
        throw unavailable;
      }
      return { plan: directPlan, auth: "must-not-be-used" };
    });
    const materializeModel = vi.fn(async () => platformModel);

    await expect(
      resolvePreparedRuntimeAuthAttempts({
        attempts: profileThenDirect(profilePlan, directPlan),
        store: authStore({
          "openai:cold": createApiKeyCredential("openai", "unused"),
        }),
        modelId: "gpt-5.5",
        model: platformModel,
        materializeModel,
        resolveAuth,
        errorMessage: "prepared auth failed",
      }),
    ).rejects.toBe(unavailable);
    expect(resolveAuth).toHaveBeenCalledOnce();
    expect(materializeModel).toHaveBeenCalledOnce();
  });

  it("does not unlock direct fallback after a prepared OAuth refresh failure", async () => {
    const profilePlan = makeProfilePlan("openai:oauth", ["openai:oauth"]);
    const directPlan = {
      ...authProvider,
      selectedAuthMode: "api-key",
    };
    const refreshFailure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: "openai:oauth",
      message: "OAuth token refresh failed for openai: expired refresh credential",
    });
    const resolveAuth = vi.fn(async ({ attempt }: { attempt: { kind: string } }) => {
      if (attempt.kind === "profile") {
        throw refreshFailure;
      }
      return { plan: directPlan, auth: "must-not-be-used" };
    });
    const materializeModel = vi.fn(async () => platformModel);

    await expect(
      resolvePreparedRuntimeAuthAttempts({
        attempts: profileThenDirect(profilePlan, directPlan),
        store: authStore({
          "openai:oauth": oauth("expired-access", "expired-refresh", Date.now() - 60_000),
        }),
        modelId: "gpt-5.5",
        model: platformModel,
        materializeModel,
        resolveAuth,
        errorMessage: "prepared auth failed",
      }),
    ).rejects.toBe(refreshFailure);
    expect(resolveAuth).toHaveBeenCalledOnce();
    expect(materializeModel).toHaveBeenCalledOnce();
  });

  it("forces unscoped model rematerialization for direct fallback after profile failure", async () => {
    const store = authStore({
      "github-copilot:first": {
        type: "token",
        provider: "github-copilot",
        token: "profile-token",
      },
    });
    const profilePlan = {
      providerForAuth: "github-copilot",
      authProfileProviderForAuth: "github-copilot",
      forwardedAuthProfileId: "github-copilot:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["github-copilot:first"],
    };
    const directPlan = {
      providerForAuth: "github-copilot",
      authProfileProviderForAuth: "github-copilot",
      selectedAuthMode: "token",
    };
    const profileModel = { ...platformModel, contextWindow: 1_050_000 };
    const directModel = { ...platformModel, contextWindow: 400_000 };
    const materializeModel = vi.fn(async ({ forceResolve }: { forceResolve?: boolean }) =>
      forceResolve ? directModel : profileModel,
    );
    const resolveAuth = vi.fn(
      async ({ attempt }: { attempt: { kind: "direct" | "implicit" | "profile" } }) => {
        if (attempt.kind === "profile") {
          throw new Error("profile credential failed");
        }
        return { plan: directPlan, auth: "direct" };
      },
    );

    const result = await resolvePreparedRuntimeAuthAttempts({
      attempts: profileThenDirect(profilePlan, directPlan),
      store,
      modelId: "gpt-5.6-sol",
      model: platformModel,
      materializeModel,
      resolveAuth,
      errorMessage: "prepared auth failed",
    });

    expect(result).toMatchObject({ auth: "direct", model: { contextWindow: 400_000 } });
    expect(materializeModel.mock.calls.map(([input]) => input.forceResolve)).toEqual([false, true]);
  });

  it("forces the first direct model when provider metadata is credential-scoped", async () => {
    const directPlan = {
      providerForAuth: "github-copilot",
      authProfileProviderForAuth: "github-copilot",
      selectedAuthMode: "api-key",
    };
    const directModel = { ...platformModel, contextWindow: 1_050_000 };
    const materializeModel = vi.fn(async () => directModel);

    const result = await resolvePreparedRuntimeAuthAttempts({
      attempts: [
        {
          kind: "direct",
          plan: directPlan,
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: false,
        },
      ],
      store: authStore({}),
      modelId: "gpt-5.6-sol",
      model: platformModel,
      materializeModel,
      resolveAuth: async () => ({ plan: directPlan, auth: "direct" }),
      forceCredentialScopedDirectModelResolve: true,
      errorMessage: "prepared auth failed",
    });

    expect(result.model).toBe(directModel);
    expect(materializeModel).toHaveBeenCalledWith({
      plan: directPlan,
      model: platformModel,
      forceResolve: true,
    });
  });

  it("keeps a user-locked profile terminal when environment auth is also present", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    const store = authStore({
      "openai:locked": createApiKeyCredential("openai", "codex-app-server"),
    });

    await expectAuth({
      plan: {
        ...authProvider,
        forwardedAuthProfileId: "openai:locked",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:locked"],
      },
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: { profileId: "openai:locked" },
      plan: {
        forwardedAuthProfileId: "openai:locked",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:locked"],
      },
    });
  });
});
