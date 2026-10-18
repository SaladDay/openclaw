import type { JSX } from "@solidjs/web";
import type { IconName } from "../../../components/solid/icon.tsx";
import type { LazyViewError } from "../../../components/solid/lazy-view-error.tsx";
import type { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import type { AgentIdentity } from "../../../lib/identity-avatar-view.ts";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import type { SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import type {
  SidebarPanelData,
  SidebarPanelDefinitionParams,
} from "../chat-pane-embedded-types.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import type { SidebarDock, SidebarLayout, SidebarSlotId } from "../sidebar-layout.ts";

export type SidebarPanelDefinition = {
  slot: SidebarSlotId;
  label: string;
  icon: IconName;
  shortcut?: KeyboardShortcutCombo;
  available: boolean;
  unavailableReason?: string;
  content: JSX.Element;
  view?: SidebarPanelData;
  loadState?: Parameters<typeof LazyViewError>[0] | null;
  loading: Parameters<typeof PanelLoadingSkeleton>[0];
  headerAction?: JSX.Element;
  headerActionView?: SidebarPanelDefinitionParams;
  headerLink?: { href: string; label: string };
  empty: {
    description: string;
    action?: JSX.Element;
  };
};

export type SidebarRegionCallbacks = {
  /** Launcher capability; omitted by hosts without provisional tabs. */
  newTab?: {
    open: (options?: { returnPanelId?: string }) => void;
    close: () => void;
    openPanel: (slot: SidebarSlotId) => void;
    finishCloseAll: () => boolean;
  };
  activatePanel: (panelId: string) => void;
  /** Provided by hosts that can promote a side panel into the main region. */
  promotePanel?: (panelId: string) => void;
  togglePanelExpanded: (panelId?: string) => void;
  setDock: (dock: SidebarDock) => void;
  closeSlot: (slot: SidebarSlotId) => void;
  openSlot: (slot: SidebarSlotId) => void;
  reorderPanel: (panelId: string, targetPanelId: string, placement: "before" | "after") => void;
  resizePanel: (columnId: string, size: number) => void;
  setOpen: (open: boolean) => void;
};

export type RegionProps = {
  mobileHost?: ChatMobileHost;
  /** Native shell presentation; absence preserves existing consumers until their cutover. */
  presentation?: "desktop" | "mobile";
  panelIdPrefix: string;
  conversationTab?: Pick<SidebarPanelDefinition, "label"> & {
    avatar: AgentIdentity;
  };
  layout: SidebarLayout;
  panelDefinitions: SidebarPanelDefinition[];
  fetchFavicon?: LinkFaviconFetcher;
  callbacks: SidebarRegionCallbacks | null;
  narrow: boolean;
  sideFocusLocked: boolean;
  sideFocusManaged?: boolean;
  sideFocusOrigin?: () => HTMLElement | null;
  availableWidth: number;
};
export type RegionMethods = { deliverPanelEvent: (slot: SidebarSlotId, event: Event) => boolean };
export type RegionElement = SolidBridgeElement<RegionProps, RegionMethods>;
