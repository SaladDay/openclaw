import type { Client, Tool } from "@modelcontextprotocol/client";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { getSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import type { createMcpRequestLifecycle } from "./mcp-client-lifecycle.js";
import { collectMcpPaginatedItems } from "./mcp-pagination.js";

export const MCP_CATALOG_LIST_LIMITS = {
  maxPages: 128,
  maxItems: 16_384,
  maxBytes: 10 * 1024 * 1024,
} as const;

export async function listAllMcpTools(
  client: Client,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Tool[]> {
  return await collectMcpPaginatedItems({
    label: "MCP tool listing",
    itemLabel: "tools",
    timeoutMs,
    ...MCP_CATALOG_LIST_LIMITS,
    signal,
    loadPage: async ({ cursor, requestTimeoutMs, signal: requestSignal }) => {
      const requestController = new AbortController();
      const onAbort = () => requestController.abort(requestSignal.reason);
      requestSignal.addEventListener("abort", onAbort, { once: true });
      if (requestSignal.aborted) {
        onAbort();
      }
      try {
        const page = await client.request(
          { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
          {
            timeout: requestTimeoutMs,
            maxTotalTimeout: requestTimeoutMs,
            signal: requestController.signal,
          },
        );
        return { items: page.tools, nextCursor: page.nextCursor, serializedValue: page };
      } finally {
        requestSignal.removeEventListener("abort", onAbort);
      }
    },
  });
}

// Tool materialization awaits catalog listing. Bound it for servers without an
// explicit request timeout, with room for a cold remote (OAuth, HTTP) listing.
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 10_000;

export function getCatalogListTimeoutMs(rawServer: unknown, requestTimeoutMs: number): number {
  const record = asOptionalObjectRecord(rawServer);
  const configured = ["requestTimeoutMs", "timeout"].some(
    (key) => asPositiveFiniteNumber(record?.[key]) !== undefined,
  );
  return configured ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;
}

export function listAllMcpServerItems(
  session: { client: Client; requestTimeoutMs: number },
  kind: "prompts" | "resources",
  requests: ReturnType<typeof createMcpRequestLifecycle>,
  lifecycleSignal: AbortSignal,
) {
  const callerSignal = getSessionMcpRequestSignal();
  return collectMcpPaginatedItems({
    label: `MCP ${kind === "resources" ? "resource" : "prompt"} listing`,
    itemLabel: kind,
    timeoutMs: session.requestTimeoutMs,
    ...MCP_CATALOG_LIST_LIMITS,
    signal: callerSignal ? AbortSignal.any([lifecycleSignal, callerSignal]) : lifecycleSignal,
    loadPage: ({ cursor, requestTimeoutMs: timeout, signal }) =>
      requests.run(
        session,
        async (requestSignal) => {
          const requestParams = cursor === undefined ? undefined : { cursor };
          const requestOptions = { timeout, maxTotalTimeout: timeout, signal: requestSignal };
          const page =
            kind === "resources"
              ? await session.client.request(
                  { method: "resources/list", params: requestParams },
                  requestOptions,
                )
              : await session.client.request(
                  { method: "prompts/list", params: requestParams },
                  requestOptions,
                );
          const items = page[kind] as unknown[];
          return { items, nextCursor: page.nextCursor, serializedValue: page };
        },
        signal,
      ),
  });
}
