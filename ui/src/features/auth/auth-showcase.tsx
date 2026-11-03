import "@fontsource-variable/caveat";
import "@fontsource/patrick-hand/latin.css";
import "@fontsource/patrick-hand/vietnamese.css";
import { PlugIcon } from "lucide-react";
import type { CSSProperties, JSX } from "react";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { Badge } from "@/components/ui/badge";
import type { Lang } from "@/lib/i18n";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Grainy purple mesh: deep violet pooling at the left and lower right, lavender glowing across
 * the upper right and the centre. Each layer is a soft radial blob over a lavender base; the
 * stops were tuned against the design reference (mean error under 5/255 per channel).
 */
const MESH: CSSProperties = {
  backgroundColor: "#c697e3",
  backgroundImage: [
    // A deeper wash behind the product line, so white text keeps AA on every panel size.
    "radial-gradient(70% 26% at 22% 13%, rgb(91 43 191 / 0.62) 0%, rgb(91 43 191 / 0.4) 45%, rgb(91 43 191 / 0) 100%)",
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
 * Handwriting per script: Caveat has no Vietnamese tone marks, so Vietnamese uses Patrick Hand,
 * and Chinese falls back to the system Kai (brush) faces.
 */
const HAND_FONT: Record<Lang, string> = {
  en: '"Caveat Variable", cursive',
  "pt-BR": '"Caveat Variable", cursive',
  vi: '"Patrick Hand", cursive',
  zh: '"Caveat Variable", "Kaiti SC", STKaiti, KaiTi, "BiauKai", "AR PL UKai CN", cursive',
  pseudo: '"Caveat Variable", cursive',
};

/** Deep violet ink: at least 6:1 on the lavender glow the note sits on. */
const INK = "#2a0b5c";

type Health = "active" | "outOfCredits" | "expired";

/** Made-up rows for the preview only; nothing here comes from the server. */
const SAMPLE_ACCOUNTS: readonly {
  email: string;
  plan: "proPlus" | "power" | "pro" | "free";
  health: Health;
  used: number;
  requests: number;
}[] = [
  { email: "maya***@gmail.com", plan: "proPlus", health: "active", used: 62, requests: 12480 },
  { email: "dev.***@outlook.com", plan: "power", health: "active", used: 35, requests: 9912 },
  { email: "arjun***@gmail.com", plan: "pro", health: "outOfCredits", used: 100, requests: 8301 },
  { email: "team***@company.dev", plan: "pro", health: "active", used: 48, requests: 7204 },
];

const HEALTH_VARIANT = {
  active: "success",
  outOfCredits: "warning",
  expired: "error",
} as const satisfies Record<Health, "success" | "warning" | "error">;

const PREVIEW_NAV = NAV_ITEMS.filter((item) =>
  ["overview", "accounts", "requests"].includes(item.id),
);

/**
 * Right half of the sign-in pages from `lg` up: a grainy purple mesh with a paper plane looping
 * across it, a handwritten note, the product line, and a cropped preview of the Accounts page
 * that the plane takes off from. The drawings and the preview are hidden from assistive tech.
 */
export function AuthShowcase(): JSX.Element {
  const { t, lang } = useT("auth");

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
      <div className="relative z-10 flex flex-col gap-5 p-12 xl:p-14">
        <ul className="flex flex-wrap gap-2">
          {[t("compatOpenAI"), t("compatAnthropic")].map((label) => (
            <li key={label}>
              <Badge className="border-white/25 bg-[#2a0b5c]/30 text-white" variant="outline">
                <PlugIcon aria-hidden="true" />
                {label}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="max-w-[24rem] text-balance font-heading font-semibold text-3xl leading-tight tracking-tight">
          {t("tagline")}
        </p>
      </div>

      <FlightPath />
      <PaperPlane />
      <p
        className="absolute top-[51%] left-[56%] z-10 max-w-[34%] -rotate-[4deg] text-balance text-[1.75rem] leading-[1.05] xl:text-[2rem]"
        style={{ color: INK, fontFamily: HAND_FONT[lang] }}
      >
        {t("showcaseNote")}
      </p>

      <AccountsPreview />
    </aside>
  );
}

/**
 * The dashed flight path, drawn in panel percentages (the SVG stretches with the panel and the
 * stroke keeps its width), from the preview's corner, round one loop, to the plane's tail.
 */
function FlightPath(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 size-full"
      fill="none"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <path
        className="motion-safe:animate-flight-dash"
        d="M 40 74 C 33 67, 30 58, 36 54 C 42 50, 51 50, 52 44 C 53 37, 45 35, 41 39 C 37 44, 42 51, 51 49 C 58 47, 65 39, 73.5 36"
        stroke="white"
        strokeDasharray="7 9"
        strokeLinecap="round"
        strokeOpacity="0.85"
        strokeWidth="2.25"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A folded paper plane in Kiro lavender, outlined in ink a touch off-register like a sketch. */
function PaperPlane(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-[33%] left-[79%] w-[clamp(5.5rem,11vw,8.5rem)] -translate-x-1/2 -translate-y-1/2"
    >
      <svg
        aria-hidden="true"
        className="w-full overflow-visible drop-shadow-[0_14px_18px_rgb(42_11_92/0.28)] motion-safe:animate-plane-float"
        fill="none"
        viewBox="0 0 120 92"
      >
        <path d="M118 4 L4 44 L46 57 Z" fill="#ffffff" />
        <path d="M118 4 L46 57 L64 88 Z" fill="#ead9fc" />
        <path d="M46 57 L40 78 L56 70 Z" fill="#b48de6" />
        <g
          stroke={INK}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.4"
          transform="translate(1.4 1.1)"
        >
          <path d="M117 4 C 80 17, 40 31, 4 44 C 18 48, 32 53, 46 57 C 52 67, 58 78, 64 88 C 82 60, 100 32, 117 4" />
          <path d="M117 5 C 94 22, 70 40, 46 57" />
          <path d="M46 57 C 44 64, 42 71, 40 78 C 45 75, 50 73, 56 70" />
        </g>
      </svg>
    </div>
  );
}

function AccountsPreview(): JSX.Element {
  const { t: tShared, lang } = useT();
  const { t: tAccounts } = useT("accounts");
  const { t: tOverview } = useT("overview");
  const number = new Intl.NumberFormat(lang);
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 });

  const stats = [
    { label: tOverview("stats.accounts"), value: number.format(7) },
    { label: tOverview("stats.available"), value: number.format(5) },
    { label: tOverview("stats.requests"), value: number.format(46034) },
    { label: tOverview("stats.successRate"), value: percent.format(0.994) },
  ];

  return (
    <div
      aria-hidden="true"
      className="absolute right-0 bottom-0 h-[30%] w-[68%] select-none overflow-hidden rounded-tl-2xl border-white/25 border-t border-l bg-card text-card-foreground shadow-2xl shadow-[#2a0b5c]/40"
    >
      <div className="flex min-w-[40rem] flex-col gap-5 p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <img alt="" className="size-6" height={24} src="/admin/icon.webp" width={24} />
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
            <div className="rounded-xl border bg-background/60 px-3.5 py-3" key={stat.label}>
              <dt className="truncate text-muted-foreground text-xs">{stat.label}</dt>
              <dd className="mt-1 font-semibold text-lg tabular-nums">{stat.value}</dd>
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
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{row.email}</span>
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                      {tAccounts(`subscription.${row.plan}`)}
                    </span>
                  </div>
                </td>
                <td className="py-3 pr-4">
                  <Badge variant={HEALTH_VARIANT[row.health]}>
                    {tAccounts(`health.${row.health}`)}
                  </Badge>
                </td>
                <td className="py-3 pr-4">
                  <div className="h-1.5 w-28 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        row.used >= 100 ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${row.used}%` }}
                    />
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
