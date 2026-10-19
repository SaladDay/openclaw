import { Portal } from "@solidjs/web";
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  type Element,
} from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../../lib/solid-bridge.ts";
import {
  ChatDetailsMobileHostContent,
  type MobileDetailsBindings,
} from "../chat-details-mobile-host-content.tsx";
import type { ChatMobileHost } from "../chat-mobile-host.ts";
import { ChatDetailsProgress } from "./chat-details-progress.tsx";
import { ChatDetailsSession, ChatDetailsDesktopComposition } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "../../../styles/chat/details.css";

type Props = {
  props?: ChatDetailsProps;
  presented: boolean;
  mobile: boolean;
  nativePresentation?: "desktop" | "mobile";
  mobileHost?: ChatMobileHost;
  mobileBindings?: MobileDetailsBindings;
  conversationVisible?: boolean;
  externalTrigger?: boolean;
  triggerContent?: Element;
};
type Methods = { open(source: HTMLElement): void };
export type ChatDetails = SolidBridgeElement<Props, Methods>;
const controls = new WeakMap<HTMLElement, Methods>();
let nextId = 0;

const DETAILS_WIDTH = 300;
// Preserve the 48rem reading column plus its gutters before offering automatic docking.
const DETAILS_DOCK_MIN_WIDTH = 1200;

/** Pane-local adaptive presentation. Data and mutations remain with the pane. */
export const ChatDetails = defineSolidBridge<Props, Methods>(
  "openclaw-chat-details",
  (props, host) => {
    const presentation = createMemo(
      () =>
        [
          props.props?.sessionKey,
          props.props?.currentAgentId,
          props.props?.selectedSession?.sessionId,
          props.props?.gatewayScope,
        ] as const,
      { equals: (before, after) => before.every((value, index) => value === after[index]) },
    );
    const scope = createMemo(() => ({ value: props.props?.gatewayScope }), {
      equals: (before, after) => before.value === after.value,
    });
    // Session replacement resets intent; parking forgets only an explicitly open inspector.
    const [choice, setChoice] = createSignal<{
      presentation: ReturnType<typeof presentation>;
      intent: "auto" | "open" | "closed";
    }>((previous) => {
      const current = presentation();
      const presented = props.presented;
      return {
        presentation: current,
        intent:
          previous?.presentation === current && (presented || previous.intent !== "open")
            ? previous.intent
            : "auto",
      };
    });
    const intent = () => choice().intent;
    const desktop = () =>
      props.nativePresentation === "desktop" && !props.mobile && !props.mobileHost;
    let manualChange = false;
    const setIntent = (nextIntent: "auto" | "open" | "closed", manual = false) => {
      manualChange = manual && (nextIntent === "open") !== opened();
      setChoice((previous) => ({ ...previous, intent: nextIntent }));
    };
    const [wideEnough, setWideEnough] = createSignal(false);
    const canDock = () => !props.mobile && props.conversationVisible !== false && wideEnough();
    const opened = () =>
      props.presented &&
      (props.mobileHost
        ? props.mobileHost.open &&
          !props.mobileHost.suspended &&
          props.mobileHost.destination.area === "details" &&
          (!props.mobileHost.destination.page || Boolean(props.mobileHost.destination.page.details))
        : intent() === "open" || (intent() === "auto" && canDock()));
    const docked = () => opened() && canDock();
    const surface = document.createElement("div");
    surface.style.display = "contents";
    let frame: HTMLElement | null = null;
    let pane: HTMLElement | null = null;
    const panelId = `chat-details-${++nextId}`;
    let panel!: HTMLDivElement;
    let trigger!: HTMLButtonElement;
    let opener: { presentation: ReturnType<typeof presentation>; element: HTMLElement } | undefined;
    const focusSource = (mobile: boolean, externalTrigger: boolean) =>
      mobile || externalTrigger
        ? opener?.presentation === presentation()
          ? opener.element
          : undefined
        : trigger;
    let progressMenu: MenuHandle | undefined;
    const mountSurface = (mobile: boolean, conversationVisible: boolean) => {
      // Fullscreen panels hide the conversation frame, but not the pane or mobile header.
      const parent =
        props.mobileHost?.detailsMount ??
        (mobile ? host : conversationVisible ? (frame ?? host) : (pane ?? host));
      if (surface.parentElement !== parent) {
        if (surface.parentElement) {
          hide();
        }
        parent.append(surface);
      }
    };
    const position = (mobile: boolean, conversationVisible: boolean, externalTrigger: boolean) => {
      if (props.mobileHost) {
        return;
      }
      const footerBounds = conversationVisible
        ? frame?.querySelector(".chat-footer")?.getBoundingClientRect()
        : undefined;
      const bounds = (
        mobile ? (pane ?? frame) : conversationVisible ? frame : (pane ?? host)
      )?.getBoundingClientRect();
      if (!panel || !bounds) {
        return;
      }
      // Dock against the layout destination, not an intermediate animation frame.
      // Otherwise the inspector releases its column halfway through a side-panel
      // opening and makes the transcript shrink past its destination, then return.
      let dockingWidth = bounds.width;
      if (desktop() && pane && conversationVisible) {
        const style = getComputedStyle(pane);
        const sideWidth = Number.parseFloat(style.getPropertyValue("--desktop-side-reserve"));
        const dividerWidth = Number.parseFloat(style.getPropertyValue("--desktop-divider-reserve"));
        const conversationIsSide =
          frame?.closest("[data-region]")?.getAttribute("data-region") === "side";
        dockingWidth = pane.getBoundingClientRect().width;
        if (
          !pane.classList.contains("sidebar-region--bottom") &&
          !pane.classList.contains("sidebar-region--expanded")
        ) {
          dockingWidth = conversationIsSide ? sideWidth : dockingWidth - sideWidth - dividerWidth;
        }
      }
      if (desktop()) {
        frame?.style.setProperty("--chat-details-frame-width", `${dockingWidth}px`);
      }
      setWideEnough(dockingWidth >= DETAILS_DOCK_MIN_WIDTH);
      if (desktop()) {
        // Measure the conversation owner, never the moving Details surface. Its
        // reservation changes the composer width, but not this frame's width.
        if (!opened()) {
          return;
        }
        const composer = conversationVisible
          ? frame?.querySelector(".agent-chat__input--chat")?.getBoundingClientRect()
          : undefined;
        const viewport = window.visualViewport;
        const headerBottom = !conversationVisible
          ? pane?.querySelector(".sidebar-region__header")?.getBoundingClientRect().bottom
          : undefined;
        const top = Math.max((headerBottom ?? bounds.top) + 8, (viewport?.offsetTop ?? 0) + 8);
        const bottom = Math.min(
          composer && composer.height > 0 ? composer.bottom : bounds.bottom - 8,
          bounds.bottom - 8,
          (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - 8,
        );
        const right = Math.min(
          bounds.right - 8,
          (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8,
        );
        const width = Math.max(0, Math.min(DETAILS_WIDTH, right - bounds.left - 8));
        panel.style.left = `${right - width - (conversationVisible ? bounds.left : 0)}px`;
        panel.style.top = `${top - (conversationVisible ? bounds.top : 0)}px`;
        panel.style.width = `${width}px`;
        panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
        panel.style.height = "auto";
        return;
      }
      if (panel.classList.contains("chat-details--docked")) {
        return;
      }
      const viewport = window.visualViewport;
      // A desktop-open inspector can survive a mobile resize without an opener.
      // Keep the persistent Panels header reachable in that case too.
      const headerBottom =
        mobile || !conversationVisible
          ? pane?.querySelector(".sidebar-region__header")?.getBoundingClientRect().bottom
          : undefined;
      const minimumTop = Math.max((headerBottom ?? bounds.top) + 8, (viewport?.offsetTop ?? 0) + 8);
      const left = Math.max(bounds.left + 8, (viewport?.offsetLeft ?? 0) + 8);
      const right = Math.min(
        bounds.right - 8,
        (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8,
      );
      const bottom =
        Math.min(
          footerBounds && footerBounds.height > 0 ? footerBounds.top : bounds.bottom,
          bounds.bottom,
          (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
        ) - 8;
      const triggerBounds = focusSource(mobile, externalTrigger)?.getBoundingClientRect();
      // The header is already above the frame: keep one gap below the trigger,
      // rather than adding its height to the conversation top a second time.
      const top = Math.max(
        minimumTop,
        Math.min((triggerBounds?.bottom ?? minimumTop) + 6, bottom - 120),
      );
      const width = mobile ? right - left : Math.min(DETAILS_WIDTH, right - left);
      panel.style.left = `${Math.max(left, right - width)}px`;
      panel.style.top = `${top}px`;
      panel.style.width = `${Math.max(0, width)}px`;
      panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    };
    const hide = () => {
      progressMenu?.overlay.request(false);
      if (panel?.matches(":popover-open")) {
        panel.hidePopover?.();
      }
    };
    const close = (restoreFocus = false, manual = false) => {
      if (props.mobileHost) {
        props.mobileHost.close();
        return;
      }
      hide();
      setIntent("closed", manual);
      if (restoreFocus && host.isConnected) {
        focusSource(props.mobile, props.externalTrigger ?? false)?.focus({ preventScroll: true });
      }
    };
    const toggle = (event: MouseEvent) => {
      panel.toggleAttribute("data-instant", event.detail === 0);
      if (opened()) {
        close(false, true);
        return;
      }
      if (!props.presented) {
        return;
      }
      setIntent("open", true);
    };
    controls.set(host, {
      open(source) {
        if (!props.presented) {
          return;
        }
        opener = { presentation: presentation(), element: source };
        panel.toggleAttribute("data-instant", source.matches(":focus-visible"));
        if (props.mobileHost) {
          props.mobileHost.navigate({ area: "details" }, source);
          return;
        }
        setIntent("open", true);
      },
    });
    const outside = (event: Event) => {
      if (
        opened() &&
        !props.mobileHost &&
        !docked() &&
        !event.composedPath().includes(host) &&
        !event.composedPath().includes(panel)
      ) {
        panel.removeAttribute("data-instant");
        close();
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        opened() &&
        (!docked() || panel.contains(document.activeElement)) &&
        !event.defaultPrevented &&
        !progressMenu?.overlay.open
      ) {
        event.preventDefault();
        panel.setAttribute("data-instant", "");
        close(true, true);
      }
    };
    // Synchronize the native popover and pane geometry with presentation intent.
    const surfacePresentation = createMemo(
      () =>
        [
          presentation(),
          opened(),
          docked(),
          props.mobile,
          props.conversationVisible ?? true,
          props.externalTrigger ?? false,
          Boolean(props.mobileHost),
          props.mobileHost?.detailsMount,
          desktop(),
          props.presented,
        ] as const,
      { equals: (before, after) => before.every((value, index) => value === after[index]) },
    );
    createEffect(
      surfacePresentation,
      (
        [
          identity,
          open,
          dock,
          mobile,
          conversationVisible,
          externalTrigger,
          mobileHost,
          _detailsMount,
          isDesktop,
          presented,
        ],
        previous,
      ) => {
        // Only a direct open/close gesture enables motion for this transition.
        // Automatic docking and retained presentation always take their final state.
        const manual =
          manualChange &&
          previous &&
          identity === previous[0] &&
          presented === previous[9] &&
          open !== previous[1];
        manualChange = false;
        panel.toggleAttribute("data-restoring", isDesktop && !manual);
        if (
          isDesktop &&
          presented &&
          (!previous || identity !== previous[0] || presented !== previous[9])
        ) {
          position(mobile, conversationVisible, externalTrigger);
        }
        if (
          !open ||
          (previous &&
            (identity !== previous[0] ||
              dock !== previous[2] ||
              mobile !== previous[3] ||
              mobileHost !== previous[6]))
        ) {
          hide();
        }
        // Let Portal register delegated events before onSettled first mounts the surface.
        // It can later move outside the header’s render root into the pane or frame.
        if (surface.parentElement) {
          mountSurface(mobile, conversationVisible);
        }
        panel.hidden = !open;
        // Preserve the last placement through the discrete exit transition.
        // Removing the dock class/geometry here would teleport a closing column.
        if (open || !isDesktop) {
          // Only the conversation-frame path slides behind side panels. Without
          // that frame, preserve the pane-level popover above the visible tools.
          panel.popover =
            (isDesktop && conversationVisible) || dock || mobileHost ? null : "manual";
          panel.style.cssText = "";
          panel.classList.toggle("chat-details--docked", dock);
        }
        panel.toggleAttribute("data-open", open);
        frame?.toggleAttribute("data-details-instant", panel.hasAttribute("data-instant"));
        frame?.toggleAttribute("data-details-restoring", panel.hasAttribute("data-restoring"));
        frame?.style.setProperty(
          "--chat-details-space",
          dock ? `${DETAILS_WIDTH + (isDesktop ? 8 : 0)}px` : "0px",
        );
        if (open && isDesktop) {
          position(mobile, conversationVisible, externalTrigger);
        }
        if (open && (!isDesktop || !conversationVisible) && !dock && !mobileHost) {
          if (!isDesktop) {
            position(mobile, conversationVisible, externalTrigger);
          }
          // Keep native Tab entry beside its header trigger after portaling the content.
          if (!panel.matches(":popover-open")) {
            panel.showPopover({ source: focusSource(mobile, externalTrigger) });
          }
        }
      },
    );
    const reposition = () => {
      mountSurface(props.mobile, props.conversationVisible ?? true);
      position(props.mobile, props.conversationVisible ?? true, props.externalTrigger ?? false);
    };
    onSettled(() => {
      pane = host.closest<HTMLElement>(".sidebar-region");
      frame =
        host.closest<HTMLElement>(".chat-main__conversation-frame") ??
        host
          .closest("openclaw-chat-pane")
          ?.querySelector<HTMLElement>(".chat-main__conversation-frame") ??
        null;
      const resize =
        typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(reposition);
      for (const element of [pane, frame, frame?.querySelector(".chat-footer")]) {
        if (element) {
          resize?.observe(element);
        }
      }
      // The pane publishes target geometry in its class/style before CSS starts
      // interpolating. ResizeObserver remains responsible for actual placement.
      const layout = new MutationObserver(reposition);
      if (pane && desktop()) {
        layout.observe(pane, { attributes: true, attributeFilter: ["class", "style"] });
      }
      reposition();
      const stop = [
        listen(window, "resize", reposition),
        listen(document, "pointerdown", outside),
        listen(document, "keydown", (event) => {
          if (event instanceof KeyboardEvent) {
            escape(event);
          }
        }),
        ...(window.visualViewport
          ? [
              listen(window.visualViewport, "resize", reposition),
              listen(window.visualViewport, "scroll", reposition),
            ]
          : []),
      ];
      return () => {
        resize?.disconnect();
        layout.disconnect();
        stop.forEach((dispose) => dispose());
      };
    });
    onCleanup(() => {
      controls.delete(host);
      hide();
      frame?.style.removeProperty("--chat-details-space");
      frame?.style.removeProperty("--chat-details-frame-width");
      frame?.removeAttribute("data-details-instant");
      frame?.removeAttribute("data-details-restoring");
      surface.remove();
    });
    return (
      <>
        <button
          ref={(element) => (trigger = element)}
          class="chat-details-toggle"
          hidden={props.mobile || props.externalTrigger}
          type="button"
          aria-label={t("chat.sessionDetails.title")}
          title={props.triggerContent ? t("chat.sessionDetails.title") : undefined}
          aria-controls={panelId}
          aria-expanded={opened() ? "true" : "false"}
          aria-haspopup={docked() ? undefined : "dialog"}
          onClick={toggle}
        >
          <Show
            when={props.triggerContent}
            fallback={
              <>
                <Icon name="listChecks" />
                <span>{t("chat.sessionDetails.title")}</span>
              </>
            }
          >
            {props.triggerContent}
          </Show>
        </button>
        <Portal mount={surface}>
          <div
            ref={(element) => (panel = element)}
            class="chat-details"
            data-desktop={desktop() ? "" : undefined}
            inert={desktop() && !opened()}
            id={panelId}
            popover="manual"
            role={docked() ? "complementary" : "dialog"}
            aria-label={t("chat.sessionDetails.title")}
          >
            <Show when={!props.mobileHost && (props.mobile || props.externalTrigger)}>
              <div class="chat-details__toolbar">
                <span>{t("chat.sessionDetails.title")}</span>
                <button
                  type="button"
                  aria-label={t("chat.sessionDetails.close")}
                  onClick={() => close(true, true)}
                >
                  <Icon name="x" />
                </button>
              </div>
            </Show>
            <Show when={scope()} keyed>
              {(_scope) => (
                <Show
                  when={props.nativePresentation === "desktop"}
                  fallback={
                    <Show
                      when={props.mobileHost && props.props}
                      fallback={
                        <>
                          <ChatDetailsSession
                            props={props.props}
                            presented={props.presented && opened()}
                            dismissed={
                              props.mobileHost ? !props.mobileHost.open : intent() === "closed"
                            }
                          />
                          <Show
                            when={
                              props.props?.progressCard || props.props?.progressCardInitialLoading
                            }
                          >
                            <ChatDetailsProgress
                              onHideProgress={() => {
                                // The top-layer inspector must not cover the Undo toast.
                                if (!docked()) {
                                  close(true);
                                }
                              }}
                              menuRef={(menu) => {
                                progressMenu = menu;
                              }}
                              props={props.props}
                              presented={props.presented && opened()}
                            />
                          </Show>
                        </>
                      }
                    >
                      <Show when={presentation()} keyed>
                        {(_identity) => (
                          <ChatDetailsMobileHostContent
                            details={props.props!}
                            host={props.mobileHost!}
                            bindings={props.mobileBindings}
                            presented={props.presented && opened()}
                          />
                        )}
                      </Show>
                    </Show>
                  }
                >
                  <ChatDetailsDesktopComposition
                    props={props.props}
                    presented={props.presented && opened()}
                    dismissed={intent() === "closed"}
                    progressMenuRef={(menu) => {
                      progressMenu = menu;
                    }}
                    onHideProgress={() => {
                      if (!docked()) {
                        close(true);
                      }
                    }}
                  />
                </Show>
              )}
            </Show>
          </div>
        </Portal>
      </>
    );
  },
  {
    properties: {
      props: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      mobile: { default: false, type: Boolean, reflect: true },
      nativePresentation: { default: undefined, attribute: false },
      mobileHost: { default: undefined, attribute: false },
      mobileBindings: { default: undefined, attribute: false },
      conversationVisible: { default: true, type: Boolean },
      externalTrigger: { default: false, type: Boolean },
      triggerContent: { default: undefined, attribute: false },
    },
    methods: { open: (host, source) => controls.get(host)?.open(source) },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details": ChatDetails;
  }
}
