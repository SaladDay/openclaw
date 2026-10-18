/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellPresentation, ShellPresentationContext } from "../../app/app-shell-presentation.ts";
import "../../components/menu-surface.ts";
import "../../components/modal-dialog.ts";
import { createOverlay, type Overlay } from "../../components/overlay-lifecycle.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  disposeSessionViews,
  renderSessionsView,
  buildMultiResult,
  buildProps,
} from "./view.test-support.tsx";
import { SessionsView } from "./view.tsx";

afterEach(disposeSessionViews);

describe("sessions transcript search view", () => {
  it.each([true, false])(
    "keeps transcript submission separate from roster filtering (available=%s)",
    async (available) => {
      const container = document.createElement("div");
      const onTranscriptSearchChange = vi.fn();
      const onTranscriptSearch = vi.fn();
      renderSessionsView(
        {
          ...buildProps(buildMultiResult([])),
          searchQuery: "agent label",
          transcriptSearchAvailable: available,
          transcriptSearchQuery: available ? "  exact phrase  " : "hidden",
          onTranscriptSearchChange,
          onTranscriptSearch,
        },
        container,
      );
      await Promise.resolve();

      const rosterFilter = container.querySelector<HTMLInputElement>(
        '.sessions-filter-popover__search input[type="text"]',
      );
      const transcriptTrigger = container.querySelector<HTMLButtonElement>(
        ".sessions-transcript-search__trigger",
      );
      expect(rosterFilter?.value).toBe("agent label");
      expect(rosterFilter?.getAttribute("aria-label")).toBe("Filter by key, agent, label, kind…");
      expect(transcriptTrigger?.getAttribute("aria-label")).toBe(
        available ? "Search transcripts" : "Connect to the Gateway to search transcripts.",
      );
      expect(transcriptTrigger?.disabled).toBe(!available);
      expect(container.querySelector(".sessions-transcript-search__input input")).toBeNull();
      expect(container.querySelector('.settings-section__desc [role="status"]')?.textContent).toBe(
        available ? undefined : "Connect to the Gateway to search transcripts.",
      );
      if (available) {
        transcriptTrigger!.click();
        await Promise.resolve();
        const transcriptInput = container.querySelector<HTMLInputElement>(
          '.sessions-transcript-search__input input[type="search"]',
        );
        expect(transcriptInput?.value).toBe("  exact phrase  ");
        transcriptInput!.value = "different words";
        transcriptInput!.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onTranscriptSearchChange).toHaveBeenCalledWith("different words");
        expect(onTranscriptSearch).not.toHaveBeenCalled();
        container
          .querySelector(".sessions-transcript-search__form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        expect(onTranscriptSearch).toHaveBeenCalledTimes(1);
      } else {
        expect(transcriptTrigger?.closest("openclaw-tooltip")).toBeNull();
      }
      expect(onTranscriptSearch).toHaveBeenCalledTimes(available ? 1 : 0);
    },
  );

  it("removes the connection explanation when transcript search becomes available", async () => {
    const container = document.createElement("div");
    const props = buildProps(buildMultiResult([]));
    renderSessionsView({ ...props, transcriptSearchAvailable: false }, container);
    await Promise.resolve();
    expect(container.querySelector('.settings-section__desc [role="status"]')?.textContent).toBe(
      "Connect to the Gateway to search transcripts.",
    );

    renderSessionsView({ ...props, transcriptSearchAvailable: true }, container);
    await Promise.resolve();
    expect(container.querySelector('.settings-section__desc [role="status"]')).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".sessions-transcript-search__trigger")?.disabled,
    ).toBe(false);
  });

  it("renders transcript provenance and opens the matching session", async () => {
    const container = document.createElement("div");
    const onNavigateToChat = vi.fn();
    renderSessionsView(
      {
        ...buildProps(
          buildMultiResult([
            {
              key: "agent:main:launch",
              kind: "direct",
              label: "Launch planning",
              updatedAt: Date.parse("2026-07-12T12:00:00.000Z"),
            },
          ]),
        ),
        transcriptSearchQuery: "launch code",
        transcriptSearch: {
          status: "results",
          sessions: [{ key: "agent:main:launch", kind: "direct", label: "Launch planning" }],
          results: [
            {
              sessionKey: "agent:main:launch",
              sessionId: "session-launch",
              messageId: "message-1",
              role: "assistant",
              timestamp: Date.parse("2026-07-12T12:00:00.000Z"),
              snippet: "The <launch code> is ready.",
              score: 1,
            },
          ],
          indexing: true,
          truncated: true,
          archivedTranscriptsExcluded: 0,
        },
        onNavigateToChat,
      },
      container,
    );
    await Promise.resolve();

    const result = container.querySelector<HTMLButtonElement>(
      ".sessions-transcript-search__result",
    );
    expect(result?.textContent).toContain("Launch planning");
    expect(result?.textContent).toContain("Assistant");
    expect(result?.textContent).toContain("The <launch code> is ready.");
    expect(result?.querySelector("launch")).toBeNull();
    expect(container.textContent).toContain("The transcript index is still updating");
    expect(container.textContent).toContain("Showing the first 25 matches.");

    result?.click();
    expect(onNavigateToChat).toHaveBeenCalledWith("agent:main:launch");
  });
});

describe("Sessions query clearing", () => {
  it.each(["click", "Escape"])(
    "clears only the query with %s and returns focus to search",
    (action) => {
      const container = document.createElement("div");
      document.body.append(container);
      const props = {
        ...buildProps(buildMultiResult([])),
        searchQuery: "missing",
        statusFilter: "archived" as const,
        activeMinutes: "60",
        limit: "25",
        includeGlobal: false,
        groupBy: "category" as const,
        onClearFilters: vi.fn(),
        onFiltersChange: vi.fn(),
        onStatusFilterChange: vi.fn(),
      };
      const onSearchChange = vi.fn((query: string) => {
        props.searchQuery = query;
        renderSessionsView({ ...props, onSearchChange }, container);
      });
      try {
        renderSessionsView({ ...props, onSearchChange }, container);
        container.querySelector<HTMLButtonElement>(".sessions-filter-popover__trigger")!.click();
        const input = container.querySelector<HTMLInputElement>(
          ".sessions-filter-popover__search input",
        )!;
        expect(input.getAttribute("aria-label")).toBe("Filter by key, agent, label, kind…");
        const clear = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Clear search"]',
        )!;
        expect(clear).not.toBeNull();
        expect(clear.hidden).toBe(false);
        expect(clear.disabled).toBe(false);
        if (action === "click") {
          clear.focus();
          clear.click();
        } else {
          input.focus();
          const event = new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          });
          input.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(true);
        }
        expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
        expect(input.value).toBe("");
        expect(document.activeElement).toBe(input);
        expect(clear.hidden).toBe(true);
        expect(clear.disabled).toBe(true);
        expect(props.onClearFilters).not.toHaveBeenCalled();
        expect(props.onFiltersChange).not.toHaveBeenCalled();
        expect(props.onStatusFilterChange).not.toHaveBeenCalled();
        expect(
          container.querySelector<HTMLInputElement>(".session-filter-input--limit")?.value,
        ).toBe("25");
        expect(container.querySelector<HTMLSelectElement>(".session-groupby__select")?.value).toBe(
          "category",
        );
        const emptyEscape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(emptyEscape);
        expect(emptyEscape.defaultPrevented).toBe(true);
        expect(container.querySelector(".sessions-filter-popover")?.matches(":popover-open")).toBe(
          false,
        );
        expect(onSearchChange).toHaveBeenCalledTimes(1);
        container.querySelector<HTMLButtonElement>(".data-table-empty-state button")!.click();
        expect(props.onClearFilters).toHaveBeenCalledOnce();
      } finally {
        container.remove();
      }
    },
  );

  it("uses current shell drawer ownership before the drawer DOM commits", () => {
    const shell = new ShellPresentation();
    const onSearchChange = vi.fn();
    vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: true }));
    const view = mountSolid(() =>
      createComponent(ShellPresentationContext, {
        value: shell,
        get children() {
          return createComponent(SessionsView, {
            ...buildProps(buildMultiResult([])),
            searchQuery: "keep me",
            onSearchChange,
          });
        },
      }),
    );
    try {
      flush();
      const trigger = view.container.querySelector<HTMLButtonElement>(
        ".sessions-filter-popover__trigger",
      )!;
      const surface = view.container.querySelector<HTMLElement>(".sessions-filter-popover")!;
      const input = view.container.querySelector<HTMLInputElement>(
        ".sessions-filter-popover__search input",
      )!;
      const escape = () => {
        if (!surface.matches(":popover-open")) {
          trigger.click();
        }
        input.focus();
        expect(document.activeElement).toBe(input);
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      };
      shell.navDrawerOpen = true;
      escape();
      expect(onSearchChange).not.toHaveBeenCalled();
      shell.navDrawerOpen = false;
      escape();
      expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
    } finally {
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("leaves Escape to an open shadow-root menu and releases it on native hide, removal, and moves", () => {
    const container = document.createElement("div");
    const host = document.createElement("div");
    document.body.append(container, host);
    const root = host.attachShadow({ mode: "open" });
    const menu = document.createElement("openclaw-menu-surface");
    const otherDocument = document.implementation.createHTMLDocument("Moved menu");
    const onSearchChange = vi.fn();
    try {
      renderSessionsView(
        { ...buildProps(buildMultiResult([])), searchQuery: "keep me", onSearchChange },
        container,
      );
      const trigger = container.querySelector<HTMLButtonElement>(
        ".sessions-filter-popover__trigger",
      )!;
      const surface = container.querySelector<HTMLElement>(".sessions-filter-popover")!;
      const input = container.querySelector<HTMLInputElement>(
        ".sessions-filter-popover__search input",
      )!;
      const escape = () => {
        if (!surface.matches(":popover-open")) {
          trigger.click();
        }
        input.focus();
        expect(document.activeElement).toBe(input);
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      };
      root.append(menu);
      expect(menu.matches(":popover-open")).toBe(true);
      escape();
      expect(onSearchChange).not.toHaveBeenCalled();
      expect(menu.matches(":popover-open")).toBe(true);

      menu.hidePopover();
      escape();
      expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
      onSearchChange.mockClear();
      menu.showPopover();
      escape();
      expect(onSearchChange).not.toHaveBeenCalled();

      menu.remove();
      escape();
      expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
      onSearchChange.mockClear();
      root.append(menu);
      escape();
      expect(onSearchChange).not.toHaveBeenCalled();

      otherDocument.body.append(menu);
      escape();
      expect(onSearchChange).toHaveBeenCalledExactlyOnceWith("");
      onSearchChange.mockClear();
      root.append(menu);
      escape();
      expect(onSearchChange).not.toHaveBeenCalled();
    } finally {
      menu.remove();
      host.remove();
      container.remove();
    }
  });

  it.each([
    "composing",
    "IME keycode",
    "prevented",
    "unfocused",
    "modified",
    "menu",
    "popover",
    "modal",
  ])("leaves Escape to its existing owner when %s", async (owner) => {
    const container = document.createElement("div");
    document.body.append(container);
    const onSearchChange = vi.fn();
    const props = { ...buildProps(buildMultiResult([])), searchQuery: "keep me", onSearchChange };
    let overlay: HTMLElement | undefined;
    let overlayOwner: Overlay | undefined;
    try {
      renderSessionsView(props, container);
      container.querySelector<HTMLButtonElement>(".sessions-filter-popover__trigger")!.click();
      const input = container.querySelector<HTMLInputElement>(
        ".sessions-filter-popover__search input",
      )!;
      if (owner !== "unfocused") {
        input.focus();
      }
      if (owner === "menu") {
        overlay = document.createElement("openclaw-menu-surface");
        document.body.append(overlay);
      }
      if (owner === "popover") {
        overlay = document.createElement("div");
        overlay.popover = "manual";
        document.body.append(overlay);
        overlayOwner = createOverlay("sessions-search-test", undefined, { dismissEscape: false });
        overlayOwner.bindSurface(overlay);
        overlayOwner.bindTrigger(input);
        expect(overlayOwner.request(true, "none")).toBe(true);
      }
      if (owner === "modal") {
        const modal = document.createElement("openclaw-modal-dialog");
        modal.label = "Existing modal";
        overlay = modal;
        document.body.append(modal);
        await modal.updateComplete;
        expect(document.openClawModalLayers?.has(modal)).toBe(true);
        input.focus();
        expect(document.activeElement).toBe(input);
      }
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
        isComposing: owner === "composing",
        keyCode: owner === "IME keycode" ? 229 : 0,
        ctrlKey: owner === "modified",
      });
      if (owner === "prevented") {
        event.preventDefault();
      }
      input.dispatchEvent(event);
      expect(onSearchChange).not.toHaveBeenCalled();
      expect(input.value).toBe("keep me");
      if (owner === "prevented") {
        expect(event.defaultPrevented).toBe(true);
      }
    } finally {
      overlayOwner?.dispose();
      overlay?.removeAttribute("open");
      overlay?.remove();
      container.remove();
    }
  });
});
