import type { GatewaySessionRow } from "../../api/types.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
import type * as SessionOperations from "../../components/session-organizer-operations.runtime.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionRenameValue } from "../../lib/session-rename.ts";
import { resolveChatAgentId } from "./chat-agent-id.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { HeaderMenuAction } from "./components/chat-header-session-menu.ts";

type HeaderMetadataAction = Extract<
  HeaderMenuAction,
  { kind: "toggle-unread" | "set-icon" | "set-color" | "set-communication" | "reset-appearance" }
>;

export function headerSessionMetadataPatch(
  action: HeaderMetadataAction,
  session: Pick<GatewaySessionRow, "unread">,
) {
  switch (action.kind) {
    case "toggle-unread":
      return { unread: !session.unread };
    case "set-icon":
      return { icon: action.icon };
    case "set-color":
      return { color: action.color };
    case "set-communication":
      return { communication: action.communication };
    case "reset-appearance":
      return { icon: null, color: null };
  }
  return action satisfies never;
}

/** The header supplies its live mutation owner; the organizer retains the dialog and operation. */
export async function renameSession(
  operations: Pick<typeof SessionOperations, "renameSession">,
  host: SessionOperations.SessionActionHost,
  row: GatewaySessionRow,
  scope: SidebarSessionMutationScope,
  state: ChatPageHost | null,
): Promise<void> {
  if (!host.sessionData.isSessionMutationScopeCurrent(scope)) {
    return;
  }
  const access = readSessionMethodAccess(scope.gateway.snapshot, {
    method: "sessions.patch",
    params: { key: row.key, label: null },
    sessionScope: true,
    session: row,
  });
  if (!access.allowed) {
    host.sessionData.publishSessionMutationError(scope, access.reason);
    return;
  }
  await operations.renameSession(
    host,
    {
      key: row.key,
      sessionId: row.sessionId,
      sharingRole: row.sharingRole,
      agentId: state ? resolveChatAgentId(state) : row.agentId,
      label: row.label ?? "",
      renameValue: resolveSessionRenameValue(row),
      userLabel: row.label,
      pinned: row.pinned === true,
      active: true,
    },
    scope,
  );
}
