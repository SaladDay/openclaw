import type { Element } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { PresentationValue } from "../../lib/presentation.ts";
import { detailsOutputsIcons } from "./chat-details-mobile-host-content.tsx";
import type { ChatMobileHost } from "./chat-mobile-host.ts";
import { ChatPaneBrowserAnnotationRender } from "./chat-pane-browser-annotation-render.ts";
import type { PaneDetailsProps } from "./chat-pane-header-view.tsx";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.tsx";
import type { ChatDetailsProps } from "./components/chat-details-types.ts";
import {
  getSessionWorkspace,
  isCurrentSessionWorkspace,
  trackSessionCheckoutSidebar,
} from "./components/chat-session-workspace-state.ts";
import { resolveSessionDiffSidebarContent } from "./components/chat-session-workspace.ts";
import { sidebarMainPanel, type SidebarLayout } from "./sidebar-layout.ts";

export type PaneDetailsActions = Pick<
  ChatDetailsProps,
  | "onShowTaskProgressChange"
  | "onHideTaskProgress"
  | "onCollapseTaskProgressChange"
  | "onOpenTaskProgressSettings"
  | "onClearSavedProgressCard"
  | "progressCardRefresh"
>;

export abstract class ChatPaneHeaderLayout extends ChatPaneBrowserAnnotationRender {
  dashboardControls: Element | undefined = undefined;
  protected readonly setDashboardControls = (action: Element | undefined) => {
    if (this.dashboardControls === action) {
      return;
    }
    this.dashboardControls = action;
  };

  protected renderHeaderDetails(input: {
    state: ChatPageHost;
    selectedSession: GatewaySessionRow | undefined;
    chatProps: ChatProps;
    paneChatProps: ChatProps;
    detailsActions: PaneDetailsActions;
    subagentStop: { onAbort: () => void } | undefined;
    ownsSubagentsPanel: boolean;
    mobileHost: ChatMobileHost | undefined;
    sidebarLayout: SidebarLayout;
    headerPresentation: PresentationValue;
    panePresentation: PresentationValue;
    conversationVisible: boolean;
  }) {
    const {
      state,
      selectedSession,
      chatProps,
      paneChatProps,
      detailsActions,
      subagentStop,
      ownsSubagentsPanel,
      mobileHost,
      sidebarLayout,
      headerPresentation,
      panePresentation,
      conversationVisible,
    } = input;
    const detailsOutputs = this.captureDetailsOutputs(detailsOutputsIcons);
    const diffWorkspace = getSessionWorkspace(state);
    const diffContent = resolveSessionDiffSidebarContent(state);
    const environment =
      diffContent?.kind === "session-diff"
        ? {
            uncommitted: diffContent.uncommitted,
            onRequestUncommitted: state.connected ? diffContent.requestUncommitted : undefined,
            onOpenUncommitted: () => {
              if (
                !isCurrentSessionWorkspace(state, diffWorkspace) ||
                diffWorkspace.diffContent !== diffContent
              ) {
                return;
              }
              const content = {
                ...diffContent,
                presentation: {
                  ...diffContent.presentation,
                  scopeRequest: {
                    owner: diffContent.owner,
                    scope: { scope: "uncommitted" as const },
                  },
                },
              };
              trackSessionCheckoutSidebar(content);
              diffWorkspace.diffContent = content;
              state.handleOpenSidebar(content);
              this.navigateMobileHost({
                area: "panels",
                slot: "detail",
                backTo: mobileHost?.destination,
              });
            },
          }
        : undefined;
    const detailsProgress = this.detailsProgressCardPresentation;
    const headerDetails: PaneDetailsProps | undefined = ownsSubagentsPanel
      ? {
          chat: {
            ...paneChatProps,
            ...detailsActions,
            ...detailsOutputs,
            environment,
            outputs: detailsOutputs.outputs
              ? {
                  ...detailsOutputs.outputs,
                  onOpenArtifact: (id) => {
                    detailsOutputs.outputs?.onOpenArtifact(id);
                    this.navigateMobileHost({
                      area: "panels",
                      slot: "workspace",
                      backTo: mobileHost?.destination,
                    });
                  },
                  onViewAll: () => {
                    detailsOutputs.outputs?.onViewAll();
                    this.navigateMobileHost({
                      area: "panels",
                      slot: "workspace",
                      backTo: mobileHost?.destination,
                    });
                  },
                  dashboard: detailsOutputs.outputs.dashboard
                    ? {
                        ...detailsOutputs.outputs.dashboard,
                        onOpen: () => {
                          detailsOutputs.outputs?.dashboard?.onOpen();
                          this.navigateMobileHost({
                            area: "panels",
                            slot: "dashboard",
                            backTo: mobileHost?.destination,
                          });
                        },
                      }
                    : detailsOutputs.outputs.dashboard,
                }
              : undefined,
            progressCard: detailsProgress?.card ?? null,
            progressCardIdentity: detailsProgress?.identity,
            progressCardLifetime: detailsProgress?.lifetime,
            progressCardInitialLoading: this.detailsProgressCardInitialLoading,
            progressCardError: this.detailsProgressCardError ?? undefined,
            showTaskProgress: this.showTaskProgress,
            desktopPresentation: {
              peopleLabel: t("chat.mobileDetails.people"),
              outputsLabel: t("chat.mobileDetails.outputs"),
              subagentsWorkingLabel: t("chat.subagentsPanel.desktopWorking"),
            },
            onSessionSelect: (key) => this.onPaneSessionChange?.(this.paneId, key),
            onOpenSubagent: (key) => {
              this.showSubagents(key);
              this.navigateMobileHost({
                area: "panels",
                slot: "subagents",
                backTo: { area: "details" },
              });
            },
            onOpenSubagents: () => {
              this.showSubagents(null);
              this.navigateMobileHost({
                area: "panels",
                slot: "subagents",
                backTo: { area: "details" },
              });
            },
            onOpenProcesses: () => {
              this.requestBackgroundPanel("processes", "open");
              this.navigateMobileHost({
                area: "panels",
                slot: "processes",
                backTo: { area: "details" },
              });
            },
          },
          mobileBindings: {
            sharing: this.prepareSessionSharing(selectedSession, {
              personActivity: chatProps.personActivity,
            }),
            goal: {
              connected: chatProps.connected,
              canAct:
                chatProps.connected &&
                chatProps.canSend &&
                !chatProps.submitDisabledReason &&
                Boolean(chatProps.currentSessionId) &&
                !chatProps.goalRecovery,
              sessionId: chatProps.currentSessionId ?? undefined,
              recovery: chatProps.goalRecovery,
              onGoalAction: chatProps.onGoalAction,
              onGoalSubmit: chatProps.onGoalSubmit,
            },
            pullRequests: this.repository.target
              ? {
                  snapshot: this.repository.target.store.get(this.repository.target.key),
                  requestRefresh: () =>
                    this.repository.target?.store.refresh(this.repository.target.key) ?? false,
                }
              : undefined,
          },
          mobile: this.mergedChrome && !this.onBackToSubagents,
          nativePresentation: this.sessionPresentation,
          mobileHost,
          // Details reserves header-owned geometry during retained navigation previews.
          presentation:
            this.sessionPresentation === "desktop" ? headerPresentation : panePresentation,
          conversationVisible,
          externalTrigger:
            (sidebarMainPanel(sidebarLayout)?.slot ?? "conversation") !== "conversation",
          setRef: (details) => {
            this.headerDetailsRef.value = details;
          },
        }
      : undefined;
    const subagentHeader = this.onBackToSubagents
      ? {
          sessionKey: state.sessionKey,
          onBack: this.onBackToSubagents,
          title: this.resolveHeaderSessionTitle(selectedSession),
          stop: subagentStop,
          details: headerDetails,
          mobile: this.sessionPresentation === "mobile",
          desktop:
            this.sessionPresentation === "desktop" ? { sessionKey: state.sessionKey } : undefined,
        }
      : null;
    return { headerDetails, subagentHeader };
  }
}
