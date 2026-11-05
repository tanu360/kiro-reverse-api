import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleArrowUp02Icon,
  CircleXIcon,
  Clock01Icon,
  Copy01Icon,
  EllipsisVerticalIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  Globe02Icon,
  InfoIcon,
  LanguagesIcon,
  LayoutDashboardIcon,
  LogInIcon,
  LogOutIcon,
  Moon02Icon,
  PlugIcon,
  PlusIcon,
  RefreshCwIcon,
  Sun03Icon,
  UserRoundIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  type ComponentProps,
  type ForwardRefExoticComponent,
  type RefAttributes,
  useEffect,
  useRef,
} from "react";
import { ChevronDownIcon as ChevronDownMotion } from "@/components/animated-icons/chevron-down";
import { CircleXIcon as CircleXMotion } from "@/components/animated-icons/circle-x";
import { Clock01Icon as Clock01Motion } from "@/components/animated-icons/clock-01";
import { Copy01Icon as Copy01Motion } from "@/components/animated-icons/copy-01";
import { DashboardSquare01Icon as DashboardMotion } from "@/components/animated-icons/dashboard-square-01";
import { ExternalLinkIcon as ExternalLinkMotion } from "@/components/animated-icons/external-link";
import { EyeIcon as EyeMotion } from "@/components/animated-icons/eye";
import { EyeOffIcon as EyeOffMotion } from "@/components/animated-icons/eye-off";
import { InformationCircleIcon as InfoMotion } from "@/components/animated-icons/information-circle";
import { Login01Icon as LoginMotion } from "@/components/animated-icons/login-01";
import { Logout01Icon as LogoutMotion } from "@/components/animated-icons/logout-01";
import { MoreVerticalIcon as MoreVerticalMotion } from "@/components/animated-icons/more-vertical";
import { PlusSignIcon as PlusMotion } from "@/components/animated-icons/plus-sign";
import { RefreshIcon as RefreshMotion } from "@/components/animated-icons/refresh";
import { Sun03Icon as Sun03Motion } from "@/components/animated-icons/sun-03";
import { Tick02Icon as TickMotion } from "@/components/animated-icons/tick-02";
import { UserIcon as UserMotion } from "@/components/animated-icons/user";
import type { AnimatedIconHandle, AnimatedIconProps } from "@/lib/use-icon-animation";
import { cn } from "@/lib/utils";
import "./animated-icon.css";

type MotionIcon = ForwardRefExoticComponent<AnimatedIconProps & RefAttributes<AnimatedIconHandle>>;

/**
 * Hand-animated versions from the hugeicons-animated registry (src/components/animated-icons).
 * Some keys are Hugeicons' lucide-named glyphs and the registry draws the original Hugeicon
 * (LogIn → Login 01, Check → Tick 02): the same shape with the same meaning, so they stand in.
 */
const MOTION_ICONS = new Map<IconSvgElement, MotionIcon>([
  [ChevronDownIcon, ChevronDownMotion],
  [CircleXIcon, CircleXMotion],
  [Clock01Icon, Clock01Motion],
  [Copy01Icon, Copy01Motion],
  [LayoutDashboardIcon, DashboardMotion],
  [ExternalLinkIcon, ExternalLinkMotion],
  [EyeIcon, EyeMotion],
  [EyeOffIcon, EyeOffMotion],
  [InfoIcon, InfoMotion],
  [LogInIcon, LoginMotion],
  [LogOutIcon, LogoutMotion],
  [EllipsisVerticalIcon, MoreVerticalMotion],
  [PlusIcon, PlusMotion],
  [RefreshCwIcon, RefreshMotion],
  [Sun03Icon, Sun03Motion],
  [CheckIcon, TickMotion],
  [UserRoundIcon, UserMotion],
]);

/** Icons the registry lacks move as a whole, in CSS (animated-icon.css); `lift` by default. */
type CssMotion = "lift" | "turn" | "tilt";
const CSS_MOTIONS = new Map<IconSvgElement, CssMotion>([
  [ArchiveIcon, "lift"],
  [CircleArrowUp02Icon, "lift"],
  [Globe02Icon, "turn"],
  [LanguagesIcon, "tilt"],
  [Moon02Icon, "tilt"],
  [PlugIcon, "tilt"],
]);

type Props = ComponentProps<typeof HugeiconsIcon> & {
  /** Play the gesture once on mount (a new alert). */
  playOnMount?: boolean;
  /** When `icon` changes, the new one plays its gesture (eye ↔ eye-off). Default true. */
  playOnSwap?: boolean;
};

/**
 * A Hugeicon that moves when the control holding it (link, button, menu item) is hovered.
 * Keeps HugeiconsIcon's props, so it drops in where a static icon was.
 */
export function AnimatedIcon({
  icon,
  className,
  playOnMount = false,
  playOnSwap = true,
  ...props
}: Props) {
  // Set after the first mount: a motion icon that mounts later has swapped in for another.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  const Motion = MOTION_ICONS.get(icon);
  if (!Motion) {
    return (
      <HugeiconsIcon
        {...props}
        icon={icon}
        className={cn("animated-icon", className)}
        data-icon-motion={CSS_MOTIONS.get(icon) ?? "lift"}
      />
    );
  }
  // The registry icons draw at Hugeicons' default stroke and take their colour from the text;
  // their ref is the play handle, not the <svg>.
  const {
    size = 24,
    altIcon: _altIcon,
    showAlt: _showAlt,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    color: _color,
    ref: _ref,
    ...svgProps
  } = props;
  return (
    <Motion
      {...svgProps}
      className={className}
      playOnMount={playOnMount || (playOnSwap && mounted.current)}
      size={Number(size)}
    />
  );
}
