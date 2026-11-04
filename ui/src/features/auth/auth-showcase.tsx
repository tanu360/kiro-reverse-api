import { CircleAlertIcon, CircleCheckIcon, ClockIcon, type LucideIcon } from "lucide-react";
import { type CSSProperties, type JSX, useId } from "react";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { AppIcon } from "@/components/shared/app-icon";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { ClaudeLogo, CodexLogo, OpenAILogo } from "./brand-logos";

/**
 * Grainy purple mesh: deep violet pooling at the left and lower right, lavender glowing across
 * the upper right and the centre. Each layer is a soft radial blob over a lavender base; the
 * stops were tuned against the design reference (mean error under 5/255 per channel).
 */
const MESH: CSSProperties = {
  backgroundColor: "#c697e3",
  backgroundImage: [
    // A deeper wash behind the product line (two lines wide), so white text keeps AA on every
    // panel size.
    "radial-gradient(92% 21% at 34% 11%, rgb(91 43 191 / 0.66) 0%, rgb(91 43 191 / 0.48) 50%, rgb(91 43 191 / 0) 100%)",
    // A lavender glow across the middle, between the stickers and the preview.
    "radial-gradient(36% 19% at 45% 35%, rgb(206 162 236 / 0.95) 0%, rgb(206 162 236 / 0.7) 55%, rgb(206 162 236 / 0) 100%)",
    "radial-gradient(62% 36% at 12% 38%, #6634b2 0%, rgb(102 52 178 / 0.85) 35%, rgb(102 52 178 / 0) 100%)",
    "radial-gradient(20% 20% at 0% 62%, #8657c4 0%, rgb(134 87 196 / 0) 100%)",
    "radial-gradient(50% 30% at 12% 2%, #7343ba 0%, rgb(115 67 186 / 0) 100%)",
    "radial-gradient(64% 44% at 104% 100%, #6532b0 0%, rgb(101 50 176 / 0.8) 28%, rgb(101 50 176 / 0) 100%)",
    "radial-gradient(40% 22% at 46% 2%, #8a55c8 0%, rgb(138 85 200 / 0) 100%)",
    "radial-gradient(36% 18% at 100% 0%, #a979d8 0%, rgb(169 121 216 / 0) 100%)",
    "radial-gradient(40% 10% at 45% 102%, #a26dd3 0%, rgb(162 109 211 / 0) 100%)",
    "radial-gradient(30% 14% at 2% 99%, #a874d6 0%, rgb(168 116 214 / 0) 100%)",
  ].join(","),
};

/**
 * Film grain: mid-grey fractal noise (filtered in sRGB, so it averages 50% grey and the overlay
 * blend neither lightens nor darkens the mesh). A 200 px tile, rasterised by the browser at any
 * pixel density, so it stays crisp and costs no download.
 */
const GRAIN: CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.6' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
  backgroundSize: "200px 200px",
};

/**
 * Flat sticker labels: a pastel body inside a white die-cut edge, no gloss and no shadow. The
 * bold text is at least 5.4:1 on its own pastel.
 */
const STICKER = {
  claude: { background: "#ffe9de", color: "#a3401c" },
  openai: { background: "#ecf8b8", color: "#40650f" },
  codex: { background: "#e4e8ff", color: "#3941d0" },
} as const satisfies Record<string, { background: string; color: string }>;

type Health = "active" | "outOfCredits" | "expired";

/** Made-up rows for the preview only; nothing here comes from the server. */
const SAMPLE_ACCOUNTS: readonly {
  email: string;
  plan: "proPlus" | "power" | "pro" | "free";
  health: Health;
  used: number;
  requests: number;
  /** The avatar's tint: a soft fill with the initial in the full colour. */
  hue: string;
}[] = [
  {
    email: "maya***@gmail.com",
    plan: "proPlus",
    health: "active",
    used: 62,
    requests: 12480,
    hue: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  },
  {
    email: "dev.***@outlook.com",
    plan: "power",
    health: "active",
    used: 35,
    requests: 9912,
    hue: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  },
  {
    email: "arjun***@gmail.com",
    plan: "pro",
    health: "outOfCredits",
    used: 100,
    requests: 8301,
    hue: "bg-amber-500/15 text-amber-600 dark:text-amber-300",
  },
  {
    email: "team***@company.dev",
    plan: "pro",
    health: "active",
    used: 48,
    requests: 7204,
    hue: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  },
];

/** Made-up hourly traffic and success rate for the two sparklines (0..1, oldest first). */
const SPARK_REQUESTS = [0.32, 0.38, 0.3, 0.46, 0.42, 0.55, 0.5, 0.64, 0.6, 0.74, 0.7, 0.9];
const SPARK_SUCCESS = [0.82, 0.86, 0.84, 0.9, 0.88, 0.92, 0.9, 0.94, 0.95, 0.93, 0.96, 0.97];

const HEALTH_PILL = {
  active: { tone: "success", icon: CircleCheckIcon },
  outOfCredits: { tone: "warning", icon: CircleAlertIcon },
  expired: { tone: "warning", icon: ClockIcon },
} as const satisfies Record<Health, { tone: BadgeTone; icon: LucideIcon }>;

const PREVIEW_NAV = NAV_ITEMS.filter((item) =>
  ["overview", "accounts", "requests"].includes(item.id),
);

/**
 * Right half of the sign-in pages from `lg` up: a grainy purple mesh with the product line, three
 * "works with" stickers, and a paper plane looping up from a preview of the Accounts page. The
 * drawings and the preview are hidden from assistive tech.
 */
export function AuthShowcase(): JSX.Element {
  return (
    <aside
      className="relative isolate hidden overflow-hidden rounded-3xl text-white lg:flex lg:w-[52%] lg:flex-col xl:w-[56%]"
      style={MESH}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.22] mix-blend-overlay"
        style={GRAIN}
      />
      <div className="relative z-10 px-12 pt-9 xl:px-14 xl:pt-10">
        <Tagline />
      </div>
      {/* In flow under the product line, so they follow it down if it wraps. */}
      <StickerLabels />

      <FlightPath />
      <PaperPlane />

      {/* The preview hangs from the bottom right corner. */}
      <div className="absolute right-0 bottom-0 left-[7%] z-10">
        <AccountsPreview />
      </div>
    </aside>
  );
}

/** The brands the product line names, each shown as its mark on a sticker-coloured chip. */
const TAGLINE_BRANDS = {
  openai: { name: "OpenAI", Logo: OpenAILogo, hue: STICKER.openai, tilt: -8 },
  anthropic: { name: "Anthropic", Logo: ClaudeLogo, hue: STICKER.claude, tilt: 7 },
} as const;
type TaglineBrand = keyof typeof TAGLINE_BRANDS;

/**
 * The product line, across the panel's full width. The locale string names the brands with
 * {openai} and {anthropic}; each becomes its logo on a small tilted chip in its sticker's colour
 * (the Claude mark stands for Anthropic, as on the Claude sticker), so the sentence keeps each
 * language's word order. The chips are images named after the brand, so it reads as a sentence.
 */
function Tagline(): JSX.Element {
  const { t } = useT("auth");
  const [lead = "", ...rest] = t("tagline").split(/\{(openai|anthropic)\}/);
  // The chips, the words between them and the word before the first one never break apart: a
  // narrow panel wraps before that word, not after a chip or an "&".
  const cut = lead.trimEnd().lastIndexOf(" ") + 1;
  return (
    <p className="text-pretty font-heading font-semibold text-2xl leading-snug xl:text-3xl">
      {lead.slice(0, cut)}
      <span className="whitespace-nowrap">
        {lead.slice(cut)}
        {rest.map((part, index) =>
          index % 2 === 1 ? part : <BrandChip brand={part as TaglineBrand} key={part} />,
        )}
      </span>
    </p>
  );
}

/**
 * A logo chip centred on the line's capitals. It is an inline-block that clips (overflow-hidden),
 * so its baseline is its own bottom edge, not the logo's; sitting 0.3em under the text baseline
 * puts its middle 0.35em above it, the middle of the capitals.
 */
function BrandChip({ brand }: { brand: TaglineBrand }): JSX.Element {
  const { name, Logo, hue, tilt } = TAGLINE_BRANDS[brand];
  return (
    <span
      aria-label={name}
      className="mx-[0.06em] inline-block size-[1.3em] overflow-hidden rounded-[0.32em] border-[0.09em] border-white align-[-0.3em]"
      role="img"
      style={{ background: hue.background, rotate: `${tilt}deg` }}
    >
      <span className="grid size-full place-items-center">
        <Logo className="size-[0.72em]" />
      </span>
    </span>
  );
}

/**
 * Three sticker labels for the APIs the proxy speaks, each with the brand's mark upright on a
 * small white chip inside the label, then the name and, smaller in mono, the endpoint it serves
 * (code, so it is not translated). They sit 28 px apart: neighbours tilt opposite ways, so
 * their facing corners close in by about 12 px and the narrowest gap still stays clear.
 */
function StickerLabels(): JSX.Element {
  const { t } = useT("auth");
  const labels = [
    {
      id: "claude",
      text: t("labelClaude"),
      Logo: ClaudeLogo,
      endpoint: "/v1/messages",
      hue: STICKER.claude,
      tilt: -4,
      inset: "0em",
    },
    {
      id: "openai",
      text: t("labelOpenAI"),
      Logo: OpenAILogo,
      endpoint: "/v1/chat/completions",
      hue: STICKER.openai,
      tilt: 3,
      inset: "1.6em",
    },
    {
      id: "codex",
      text: t("labelCodex"),
      Logo: CodexLogo,
      endpoint: "/v1/responses",
      hue: STICKER.codex,
      tilt: -2,
      inset: "0.5em",
    },
  ];
  return (
    <ul
      aria-label={t("worksWith")}
      className="relative z-10 ms-[7%] mt-10 flex select-none flex-col items-start self-start gap-7 font-bold text-base leading-tight xl:text-[clamp(1.125rem,1.25vw,1.5rem)]"
    >
      {labels.map(({ id, text, Logo, endpoint, hue, tilt, inset }) => (
        <li
          // The logo chip keeps a pastel margin inside the white edge, wider at the start.
          className="flex items-center gap-2 rounded-xl border-[3px] border-white py-1.5 pr-4 pl-2"
          key={id}
          style={{
            background: hue.background,
            color: hue.color,
            marginInlineStart: inset,
            rotate: `${tilt}deg`,
          }}
        >
          <span
            aria-hidden="true"
            className="grid size-[1.5em] shrink-0 place-items-center rounded-[0.45em] bg-white"
          >
            <Logo className="size-[1em]" />
          </span>
          {text}
          <span className="ms-1 font-medium font-mono text-[0.62em] opacity-75">{endpoint}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The dashed flight path, drawn in panel percentages (the SVG stretches with the panel and the
 * stroke keeps its width). It is drawn from the plane back: it starts exactly at the plane's tip
 * (FLIGHT_END), leaving it opposite to the way the plane points, then goes round one loop and
 * down to well under the preview's top edge (75%, below the edge at every zoom step). The dash
 * pattern starts at the tip; the dashes stay still (a drifting pattern made the trail look as if
 * it slid off the tip). It does not run on into the plane: in panel percentages a lead-in would
 * follow the keel's edge outside the plane on some panel shapes. Both ends fade into the
 * background (the stroke's gradient), so neither shows a cut end.
 */
function FlightPath(): JSX.Element {
  const fadeId = `flight-fade-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      fill="none"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <defs>
        {/*
         * Both ends melt into the background: clear at the plane's tail, full strength from 4%
         * below it, then clear again by 47%, just above the preview's top edge on most screens.
         */}
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={fadeId}
          x1="0"
          x2="0"
          y1={FLIGHT_END.y}
          y2="47"
        >
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.2" stopColor="white" stopOpacity="0.85" />
          <stop offset="0.62" stopColor="white" stopOpacity="0.85" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={`M ${FLIGHT_END.x} ${FLIGHT_END.y} C 74.5 31, 75.5 36, 74 39 C 72 43, 67 41, 68 37.5 C 69 34, 74.2 36, 75 41 C 76 48, 76 60, 76 75`}
        stroke={`url(#${fadeId})`}
        strokeDasharray="7 9"
        strokeLinecap="round"
        strokeWidth="2.25"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Where the flight path meets the plane's tip, in panel percentages. */
const FLIGHT_END = { x: 79.5, y: 27.5 } as const;

/**
 * A flat paper plane in Kiro lavender, four facets and no outline. Shape: "Paper plane" from the
 * Small Flat Vectors pack (svgrepo.com/svg/362134), CC0 1.0 (public domain); recoloured, and its
 * 24-unit grid moved to the origin.
 *
 * It hangs by its tip, the lowest point of its keel (7, 24 of 24: 29.17% and 100% of the box):
 * that point is pinned to the flight path's end whatever the panel's size, and the plane turns
 * and rocks about it, so the dashed trail always runs out of the tip.
 */
function PaperPlane(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute w-[clamp(5rem,8vw,8rem)] origin-[29.17%_100%] -translate-x-[29.17%] -translate-y-full rotate-[14deg]"
      style={{ left: `${FLIGHT_END.x}%`, top: `${FLIGHT_END.y}%` }}
    >
      <svg
        aria-hidden="true"
        className="w-full origin-[29.17%_100%] overflow-visible motion-safe:animate-plane-float"
        viewBox="0 0 24 24"
      >
        <path d="M24 0 18 24 8.61 19.3Z" fill="#ffffff" />
        <path d="M24 0 6 18 0 15Z" fill="#ead9fc" />
        <path d="M6 18 7 24 8.674 19.3 24 0Z" fill="#8a5cd0" />
        <path d="M7 24 10 20 8.661 19.3Z" fill="#5b2bbf" />
      </svg>
    </div>
  );
}

/**
 * The Accounts page in miniature: nav, stat tiles (each with a small drawing: avatars, available
 * bars, two sparklines) and four rows with an initial avatar and the plan's used share. It is laid out at its real size,
 * then zoomed to the panel, the smaller of a width step and a height step, so the whole of it
 * shows on common laptop screens and it grows on large ones.
 */
function AccountsPreview(): JSX.Element {
  const { t: tShared, lang } = useT();
  const { t: tAccounts } = useT("accounts");
  const { t: tOverview } = useT("overview");
  const number = new Intl.NumberFormat(lang);
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 });

  const stats: { label: string; value: string; extra: JSX.Element }[] = [
    { label: tOverview("stats.accounts"), value: number.format(7), extra: <AvatarStack /> },
    {
      label: tOverview("stats.available"),
      value: number.format(5),
      extra: <Segments filled={5} of={7} />,
    },
    {
      label: tOverview("stats.requests"),
      value: number.format(46034),
      extra: <Sparkline className="text-primary" points={SPARK_REQUESTS} />,
    },
    {
      label: tOverview("stats.successRate"),
      value: percent.format(0.994),
      extra: <Sparkline className="text-success" points={SPARK_SUCCESS} />,
    },
  ];

  return (
    <div
      aria-hidden="true"
      // Dark theme: true black like the page, not the grey-black card surface.
      className="select-none overflow-hidden rounded-tl-2xl border-white/30 border-t border-l bg-card text-card-foreground dark:bg-background"
    >
      <div
        className={cn(
          "flex min-w-[40rem] flex-col gap-5 p-6",
          // Width steps (the panel is 52% of the window, 56% from xl).
          "[--zoom-w:0.76] min-[1280px]:[--zoom-w:1] min-[1400px]:[--zoom-w:1.1] min-[1800px]:[--zoom-w:1.3]",
          // Height steps, as ranges so their order in the stylesheet cannot matter.
          "[--zoom-h:0.8] [@media(min-height:760px)_and_(max-height:799.98px)]:[--zoom-h:0.9] [@media(min-height:800px)_and_(max-height:879.98px)]:[--zoom-h:1] [@media(min-height:880px)_and_(max-height:999.98px)]:[--zoom-h:1.12] [@media(min-height:1000px)]:[--zoom-h:1.3]",
        )}
        style={{ zoom: "min(var(--zoom-w), var(--zoom-h))" }}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <AppIcon className="size-6" size={24} />
            <span className="font-semibold text-sm">{tShared("shell.appName")}</span>
          </div>
          <ul className="flex items-center gap-1 text-sm">
            {PREVIEW_NAV.map((item) => {
              const Icon = item.icon;
              const current = item.id === "accounts";
              return (
                <li
                  className={cn(
                    "flex items-center gap-1.5 rounded-full px-3 py-1.5",
                    current ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground",
                  )}
                  key={item.id}
                >
                  <Icon className="size-3.5" />
                  {tShared(item.labelKey)}
                </li>
              );
            })}
          </ul>
        </div>

        <dl className="grid grid-cols-4 gap-3">
          {stats.map((stat) => (
            // The app's panel look (components/ui/card.tsx): an outline over a faint fill.
            <div
              className="rounded-xl border border-border/60 bg-muted/40 px-3.5 py-3 dark:bg-white/[0.03]"
              key={stat.label}
            >
              <dt className="truncate text-muted-foreground text-xs">{stat.label}</dt>
              <dd className="mt-1 flex items-end justify-between gap-2">
                <span className="font-semibold text-lg tabular-nums leading-7">{stat.value}</span>
                {stat.extra}
              </dd>
            </div>
          ))}
        </dl>

        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground text-xs">
            <tr className="border-b">
              <th className="pb-2.5 font-normal">{tAccounts("columns.account")}</th>
              <th className="pb-2.5 font-normal">{tAccounts("columns.status")}</th>
              <th className="pb-2.5 font-normal">{tAccounts("columns.planCredits")}</th>
              <th className="pb-2.5 text-right font-normal">{tAccounts("columns.requests")}</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_ACCOUNTS.map((row) => (
              <tr className="border-b last:border-0" key={row.email}>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "grid size-6 shrink-0 place-items-center rounded-full font-semibold text-[11px] uppercase",
                        row.hue,
                      )}
                    >
                      {row.email.charAt(0)}
                    </span>
                    <span className="font-medium">{row.email}</span>
                    <Badge tone={row.plan === "free" ? "neutral" : "primary"}>
                      {tAccounts(`subscription.${row.plan}`)}
                    </Badge>
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <Badge icon={HEALTH_PILL[row.health].icon} tone={HEALTH_PILL[row.health].tone}>
                    {tAccounts(`health.${row.health}`)}
                  </Badge>
                </td>
                <td className="py-3 pr-4">
                  <div className="flex items-center gap-2.5">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          row.used >= 100 ? "bg-warning" : "bg-primary",
                        )}
                        style={{ width: `${row.used}%` }}
                      />
                    </div>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {percent.format(row.used / 100)}
                    </span>
                  </div>
                </td>
                <td className="py-3 text-right tabular-nums">{number.format(row.requests)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A tiny trend line for a stat tile: a 1.5 px stroke in the current colour over a fade of the
 * same colour. Decoration only (the preview is aria-hidden).
 */
function Sparkline({
  points,
  className,
}: {
  points: readonly number[];
  className?: string;
}): JSX.Element {
  const id = useId();
  const width = 56;
  const height = 22;
  const step = width / (points.length - 1);
  const line = points
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - 2 - value * (height - 4)).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0 overflow-visible", className)}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

const AVATAR_TINTS = ["bg-violet-400", "bg-sky-400", "bg-amber-400"] as const;

/** Three overlapping avatar dots, for the Accounts tile. */
function AvatarStack(): JSX.Element {
  return (
    <span className="flex shrink-0 -space-x-1.5 pb-1">
      {AVATAR_TINTS.map((tint) => (
        <span
          className={cn("size-4 rounded-full ring-2 ring-card dark:ring-background", tint)}
          key={tint}
        />
      ))}
    </span>
  );
}

/** "5 of 7" as seven short bars, the available ones in the success colour. */
function Segments({ filled, of }: { filled: number; of: number }): JSX.Element {
  const bars = Array.from({ length: of }, (_, position) => ({ position, on: position < filled }));
  return (
    <span className="flex shrink-0 gap-0.5 pb-1.5">
      {bars.map((bar) => (
        <span
          className={cn("h-2.5 w-1 rounded-full", bar.on ? "bg-success" : "bg-muted-foreground/25")}
          key={bar.position}
        />
      ))}
    </span>
  );
}
