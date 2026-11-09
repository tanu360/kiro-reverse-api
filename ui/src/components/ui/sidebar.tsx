"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { ArrowRight01Icon, PanelLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { Button, PRIMARY_FINISH } from "@/components/ui/button";
import { useUiT } from "@/components/ui/messages";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebarIsSheet } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

// Kiro patch: persist the open state in localStorage instead of the Cookie Store API,
// which Firefox lacks. The admin UI relies on no cookies.
const SIDEBAR_STORAGE_KEY: string = "kiro_sidebar_open";

function readStoredSidebarOpen(fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {}
  return fallback;
}
const SIDEBAR_WIDTH: string = "16rem";
const SIDEBAR_WIDTH_MOBILE: string = "18rem";
const SIDEBAR_WIDTH_ICON: string = "3rem";
const SIDEBAR_KEYBOARD_SHORTCUT: string = "b";

// Kiro patch: row states, geometry and icon colour follow t3code's sidebar
// (apps/web/src/components/ui/sidebar.tsx), reading the --sidebar-row-* tokens.
const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full cursor-pointer items-center gap-(--sidebar-control-gap) overflow-hidden text-left outline-hidden transition-[width,height,padding] hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-outline-inset active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 group-has-data-[sidebar=menu-action]/menu-item:pe-8 group-has-data-[sidebar=menu-chevron]/menu-item:pe-8 aria-disabled:pointer-events-none aria-disabled:opacity-64 data-[active=true]:bg-sidebar-row-selected data-[active=true]:hover:bg-sidebar-row-selected data-[active=true]:active:bg-sidebar-row-selected data-[active=true]:font-medium data-[active=true]:text-sidebar-foreground data-[state=open]:hover:bg-sidebar-row-hover data-[state=open]:hover:text-sidebar-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-(--sidebar-content-inset)! [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-(--sidebar-icon-color) hover:[&>svg]:text-sidebar-foreground active:[&>svg]:text-sidebar-foreground data-[active=true]:[&>svg]:text-sidebar-foreground",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        // Kiro patch: the nav row, 32 px (shadcn's sidebar row), and 40 px in the sheet (below
        // lg), where rows are touch targets.
        default: "h-8 rounded-lg px-(--sidebar-row-content-inset) py-1.5 text-sm max-lg:h-10",
        lg: "h-12 rounded-lg px-(--sidebar-row-content-inset) py-2 text-sm group-data-[collapsible=icon]:p-0!",
        sm: "h-7 rounded-lg px-(--sidebar-row-content-inset) py-2 text-xs",
      },
      variant: {
        // Kiro patch: labels in the sidebar text colour (80%), not the muted grey, so the
        // list reads at a glance; icons keep the quieter --sidebar-icon-color.
        default: "font-medium text-sidebar-foreground/80",
        // Kiro patch: a row whose page or section is destructive (Settings' danger zone): red
        // label and icon, a red tint on hover and while selected.
        destructive:
          "font-medium text-destructive-foreground hover:bg-error-surface hover:text-destructive-foreground active:bg-error-surface active:text-destructive-foreground data-[active=true]:bg-error-surface data-[active=true]:text-destructive-foreground data-[active=true]:hover:bg-error-surface data-[active=true]:active:bg-error-surface [&>svg]:text-destructive-foreground hover:[&>svg]:text-destructive-foreground active:[&>svg]:text-destructive-foreground data-[active=true]:[&>svg]:text-destructive-foreground",
        outline: "bg-sidebar-control-surface ring-1 ring-sidebar-border",
        // Kiro patch: the sidebar's main action in the sign-in button's look: solid purple, a
        // white centred label and icon, the grain and top highlight, a slight press.
        primary: cn(
          PRIMARY_FINISH,
          "relative justify-center bg-primary font-medium text-primary-foreground transition-[width,height,padding,scale] hover:bg-primary-hover hover:text-primary-foreground active:scale-[0.98] active:bg-primary-hover active:text-primary-foreground [&>svg]:text-primary-foreground hover:[&>svg]:text-primary-foreground active:[&>svg]:text-primary-foreground",
        ),
      },
    },
  },
);

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext: React.Context<SidebarContextProps | null> =
  React.createContext<SidebarContextProps | null>(null);

export function useSidebar(): SidebarContextProps {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  // Kiro patch: the sidebar is a sheet below lg (1024 px), not md; at 768 a persistent
  // 272 px sidebar leaves too little room for the pages.
  const isMobile = useSidebarIsSheet();
  const [openMobile, setOpenMobile] = React.useState(false);

  // This is the internal state of the sidebar.
  // We use openProp and setOpenProp for control from outside the component.
  const [_open, _setOpen] = React.useState(() => readStoredSidebarOpen(defaultOpen));
  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) {
        setOpenProp(openState);
      } else {
        _setOpen(openState);
      }

      // This stores the sidebar state so it survives a reload.
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(openState));
      } catch {}
    },
    [setOpenProp, open],
  );

  // Helper to toggle the sidebar.
  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
  }, [isMobile, setOpen]);

  // Adds a keyboard shortcut to toggle the sidebar.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  // We add a state so that we can do data-state="expanded" or "collapsed".
  // This makes it easier to style the sidebar with Tailwind classes.
  const state = open ? "expanded" : "collapsed";

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      isMobile,
      open,
      openMobile,
      setOpen,
      setOpenMobile,
      state,
      toggleSidebar,
    }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className,
        )}
        data-slot="sidebar-wrapper"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
            ...style,
          } as React.CSSProperties
        }
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  sheetTitle,
  sheetDescription,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  /** Kiro patch: screen-reader title and description of the mobile sheet (translatable). */
  sheetTitle?: string;
  sheetDescription?: string;
}): React.ReactElement {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  const { t } = useUiT();
  // Kiro patch: the sidebar-scoped palette attribute must reach the portaled mobile sheet too.
  const appSidebar = (props as { "data-app-sidebar"?: string })["data-app-sidebar"];

  if (collapsible === "none") {
    return (
      <div
        className={cn(
          "flex h-full w-(--sidebar-width) flex-col bg-sidebar surface-grain text-sidebar-foreground",
          className,
        )}
        data-slot="sidebar"
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
        <SheetPopup
          className="w-(--sidebar-width) bg-sidebar surface-grain p-0 text-sidebar-foreground [&>button]:hidden"
          data-app-sidebar={appSidebar}
          data-mobile="true"
          data-sidebar="sidebar"
          data-slot="sidebar"
          side={side}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            } as React.CSSProperties
          }
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{sheetTitle ?? t("sidebar.title")}</SheetTitle>
            <SheetDescription>{sheetDescription ?? t("sidebar.description")}</SheetDescription>
          </SheetHeader>
          {/* Kiro patch: relative + isolate, so the stage artwork can sit under the rows. */}
          <div className="relative isolate flex h-full w-full flex-col">{children}</div>
        </SheetPopup>
      </Sheet>
    );
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground lg:block"
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-side={side}
      data-slot="sidebar"
      data-state={state}
      data-variant={variant}
    >
      {/* This is what handles the sidebar gap on desktop */}
      <div
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
          "group-data-[collapsible=offcanvas]:w-0",
          "group-data-[side=right]:rotate-180",
          variant === "floating" || variant === "inset"
            ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
            : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
        data-slot="sidebar-gap"
      />
      <div
        className={cn(
          "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear lg:flex",
          side === "left"
            ? "left-0 group-data-[collapsible=offcanvas]:-left-(--sidebar-width)"
            : "right-0 group-data-[collapsible=offcanvas]:-right-(--sidebar-width)",
          // Adjust the padding for floating and inset variants.
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
            : // The edge is painted over the plain sidebar colour, not the grainy page behind, so it
              // reads as t3code's (white 8% on black: #141414).
              "bg-sidebar group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
          className,
        )}
        data-slot="sidebar-container"
        {...props}
      >
        <div
          className="relative isolate flex h-full w-full flex-col bg-sidebar surface-grain text-sidebar-foreground group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border"
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>): React.ReactElement {
  const { toggleSidebar } = useSidebar();
  const { t } = useUiT();

  return (
    <Button
      className={className}
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        onClick?.(event);
        toggleSidebar();
      }}
      size="icon"
      // Kiro patch: quiet like the other header icons (only the colour moves), not a ghost fill.
      variant="quiet"
      {...props}
    >
      <HugeiconsIcon icon={PanelLeftIcon} aria-hidden="true" />
      {/* Kiro patch: callers may pass their own aria-label; the ui namespace has the fallback. */}
      {props["aria-label"] ? null : <span className="sr-only">{t("sidebar.toggle")}</span>}
    </Button>
  );
}

export function SidebarHeader({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="header"
      data-slot="sidebar-header"
      {...props}
    />
  );
}

export function SidebarFooter({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("flex flex-col gap-2 p-2", className)}
      data-sidebar="footer"
      data-slot="sidebar-footer"
      {...props}
    />
  );
}

export function SidebarContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <ScrollArea className="min-h-0 flex-1" fill overscrollContain scrollFade>
      <div
        className={cn(
          "flex h-full flex-col gap-2 group-data-[collapsible=icon]:overflow-hidden",
          className,
        )}
        data-sidebar="content"
        data-slot="sidebar-content"
        {...props}
      />
    </ScrollArea>
  );
}

export function SidebarGroup({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  );
}

export function SidebarGroupLabel({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">): React.ReactElement {
  const defaultProps = {
    className: cn(
      "flex h-8 shrink-0 items-center rounded-lg px-(--sidebar-row-content-inset) font-medium text-sidebar-muted-foreground text-xs outline-hidden transition-[margin,opacity] duration-200 ease-linear focus-outline [&>svg]:size-4 [&>svg]:shrink-0",
      "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
      className,
    ),
    "data-sidebar": "group-label",
    "data-slot": "sidebar-group-label",
  };

  return useRender({
    defaultTagName: "div",
    props: mergeProps(defaultProps, props),
    render,
  });
}

export function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("w-full text-sm", className)}
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      {...props}
    />
  );
}

export function SidebarMenu({
  className,
  ...props
}: React.ComponentProps<"ul">): React.ReactElement {
  return (
    <ul
      className={cn("flex w-full min-w-0 flex-col gap-0.5", className)}
      data-sidebar="menu"
      data-slot="sidebar-menu"
      {...props}
    />
  );
}

export function SidebarMenuItem({
  className,
  ...props
}: React.ComponentProps<"li">): React.ReactElement {
  return (
    <li
      className={cn("group/menu-item relative", className)}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      {...props}
    />
  );
}

export function SidebarMenuButton({
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipPopup>;
} & VariantProps<typeof sidebarMenuButtonVariants>): React.ReactElement {
  // Kiro patch: the context only drives the collapsed-rail tooltip, so a button without a
  // tooltip (or rendered outside a SidebarProvider, as Settings' section nav and tests do) works
  // without it. No provider means an expanded sidebar: the tooltip stays off.
  const sidebar = React.useContext(SidebarContext);
  const isMobile = sidebar?.isMobile ?? false;
  const state = sidebar?.state ?? "expanded";

  const defaultProps = {
    className: cn(sidebarMenuButtonVariants({ size, variant }), className),
    "data-active": isActive,
    "data-sidebar": "menu-button",
    "data-size": size,
    "data-slot": "sidebar-menu-button",
  };

  const buttonProps = mergeProps<"button">(defaultProps, props);

  const buttonElement = useRender({
    defaultTagName: "button",
    props: buttonProps,
    render,
  });

  if (!tooltip) {
    return buttonElement;
  }

  if (typeof tooltip === "string") {
    tooltip = {
      children: tooltip,
    };
  }

  // Kiro patch: disable the tooltip, not only hide its popup, when the label is visible. A
  // hidden popup still opened on focus, so in the mobile sheet the first Escape closed that
  // invisible tooltip and the sheet needed a second (or third) Escape.
  const tooltipOff = state !== "collapsed" || isMobile;

  return (
    <Tooltip disabled={tooltipOff}>
      <TooltipTrigger render={buttonElement as React.ReactElement<Record<string, unknown>>} />
      <TooltipPopup align="center" hidden={tooltipOff} side="right" {...tooltip} />
    </Tooltip>
  );
}

/**
 * Kiro patch: a chevron at the end of a row that has a sub-menu. It only shows whether the
 * sub-menu is open (right when closed, down when open); the row itself opens and closes it, so
 * the chevron takes no pointer events and has no hover state of its own. Render it after the
 * SidebarMenuButton, which then keeps room for it.
 */
export function SidebarMenuChevron({
  open,
  className,
  ...props
}: React.ComponentProps<"span"> & { open: boolean }): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-e-(--sidebar-row-content-inset) flex size-4 items-center justify-center text-(--sidebar-icon-color) peer-hover/menu-button:text-sidebar-foreground peer-data-[active=true]/menu-button:text-sidebar-foreground",
        "peer-data-[size=sm]/menu-button:top-1.5",
        "peer-data-[size=default]/menu-button:top-2.5 max-lg:peer-data-[size=default]/menu-button:top-3",
        "peer-data-[size=lg]/menu-button:top-4",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-open={open}
      data-sidebar="menu-chevron"
      data-slot="sidebar-menu-chevron"
      {...props}
    >
      <HugeiconsIcon
        className={cn(
          "size-4 transition-transform duration-200 ease-out motion-reduce:transition-none",
          open && "rotate-90",
        )}
        icon={ArrowRight01Icon}
      />
    </span>
  );
}

export function SidebarMenuSub({
  className,
  ...props
}: React.ComponentProps<"ul">): React.ReactElement {
  return (
    <ul
      className={cn(
        // Kiro patch: a tree as in the reference sidebars. The line runs down the centre of
        // the parent row's icon and stops at the last row's node dot.
        "relative ms-[calc(var(--sidebar-row-content-inset)+0.5rem)] flex min-w-0 flex-col gap-0.5 ps-3.5 pt-0.5",
        "before:pointer-events-none before:absolute before:inset-s-0 before:top-0 before:bottom-4 before:w-px before:-translate-x-1/2 before:bg-sidebar-muted-foreground/25 max-lg:before:bottom-5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      {...props}
    />
  );
}

export function SidebarMenuSubItem({
  className,
  ...props
}: React.ComponentProps<"li">): React.ReactElement {
  return (
    <li
      className={cn(
        "group/menu-sub-item relative",
        // Kiro patch: the node dot on the tree line, ringed in the sidebar colour so the line
        // breaks around it; in the label colour on the selected row.
        "before:pointer-events-none before:absolute before:-inset-s-3.5 before:top-1/2 before:z-10 before:size-1.5 before:-translate-x-1/2 before:-translate-y-1/2 before:rounded-full before:bg-sidebar-muted-foreground/45 before:ring-2 before:ring-sidebar before:transition-colors hover:before:bg-sidebar-muted-foreground has-data-[active=true]:before:bg-sidebar-foreground",
        className,
      )}
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      {...props}
    />
  );
}

export function SidebarMenuSubButton({
  size = "md",
  isActive = false,
  className,
  render,
  ...props
}: useRender.ComponentProps<"a"> & {
  size?: "sm" | "md";
  isActive?: boolean;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      // Kiro patch: same row language as SidebarMenuButton (radius, inset, label colour), one
      // step shorter: 32 px, 40 px in the sheet.
      "flex h-8 min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-(--sidebar-row-content-inset) font-medium text-sidebar-foreground/80 outline-hidden hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-outline-inset active:bg-sidebar-row-active active:text-sidebar-foreground disabled:pointer-events-none disabled:opacity-64 aria-disabled:pointer-events-none aria-disabled:opacity-64 max-lg:h-10 [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-muted-foreground",
      "data-[active=true]:bg-sidebar-row-selected data-[active=true]:hover:bg-sidebar-row-selected data-[active=true]:active:bg-sidebar-row-selected data-[active=true]:text-sidebar-foreground",
      size === "sm" && "text-xs",
      size === "md" && "text-sm",
      "group-data-[collapsible=icon]:hidden",
      className,
    ),
    "data-active": isActive,
    "data-sidebar": "menu-sub-button",
    "data-size": size,
    "data-slot": "sidebar-menu-sub-button",
  };

  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">(defaultProps, props),
    render,
  });
}
