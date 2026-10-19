import type { Client, Tool } from "@modelcontextprotocol/client";
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

export function listMcpServerItems(
  kind: "prompts" | "resources",
  {
    client,
    timeoutMs,
    signal,
    runRequest,
  }: {
    client: Client;
    timeoutMs: number;
    signal: AbortSignal;
    runRequest: <T>(
      request: (signal: AbortSignal) => Promise<T>,
      signal: AbortSignal,
    ) => Promise<T>;
  },
) {
  return collectMcpPaginatedItems({
    label: `MCP ${kind === "resources" ? "resource" : "prompt"} listing`,
    itemLabel: kind,
    timeoutMs,
    ...MCP_CATALOG_LIST_LIMITS,
    signal,
    loadPage: ({ cursor, requestTimeoutMs: timeout, signal: pageSignal }) =>
      runRequest(async (requestSignal) => {
        const requestParams = cursor === undefined ? undefined : { cursor };
        const requestOptions = { timeout, maxTotalTimeout: timeout, signal: requestSignal };
        const page =
          kind === "resources"
            ? await client.request(
                { method: "resources/list", params: requestParams },
                requestOptions,
              )
            : await client.request(
                { method: "prompts/list", params: requestParams },
                requestOptions,
              );
        const items = page[kind] as unknown[];
        return { items, nextCursor: page.nextCursor, serializedValue: page };
      }, pageSignal),
  });
}
