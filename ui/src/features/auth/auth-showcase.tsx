import { PlugIcon } from "lucide-react";
import type { CSSProperties, JSX } from "react";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Kiro purple-300 → 500 → 800, fading into near-black: the scale kiro.dev uses. */
const PANEL_BACKGROUND: CSSProperties = {
  backgroundImage: [
    "radial-gradient(120% 85% at 0% 0%, #c59eff 0%, #9046ff 24%, #5e17ab 46%, transparent 72%)",
    "linear-gradient(160deg, #2a0f52 0%, #12062a 55%, #07030f 100%)",
  ].join(","),
};

/** Film grain, so the panel matches the grainy app icon. */
const GRAIN: CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
};

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
  { email: "kai***@proton.me", plan: "proPlus", health: "active", used: 71, requests: 6033 },
  { email: "lee***@gmail.com", plan: "free", health: "expired", used: 12, requests: 1140 },
  { email: "noor***@icloud.com", plan: "pro", health: "active", used: 27, requests: 964 },
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
 * Right half of the sign-in pages from `lg` up: the product line on Kiro purple, and a
 * decorative, cropped preview of the Accounts page. The preview is hidden from assistive tech.
 */
export function AuthShowcase(): JSX.Element {
  const { t } = useT("auth");

  return (
    <aside
      className="relative isolate hidden overflow-hidden rounded-3xl text-white lg:flex lg:w-[52%] lg:flex-col xl:w-[56%]"
      style={PANEL_BACKGROUND}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-25 mix-blend-overlay"
        style={GRAIN}
      />
      <div className="flex flex-col gap-5 p-12 xl:p-14">
        <ul className="flex flex-wrap gap-2">
          {[t("compatOpenAI"), t("compatAnthropic")].map((label) => (
            <li key={label}>
              <Badge className="border-white/20 bg-white/10 text-white" variant="outline">
                <PlugIcon aria-hidden="true" />
                {label}
              </Badge>
            </li>
          ))}
        </ul>
        <p className="max-w-md text-balance font-heading font-semibold text-3xl leading-tight tracking-tight">
          {t("tagline")}
        </p>
      </div>
      <AccountsPreview />
    </aside>
  );
}

function AccountsPreview(): JSX.Element {
  const { t: tShared, lang } = useT();
  const { t: tAccounts } = useT("accounts");
  const { t: tOverview } = useT("overview");
  const number = new Intl.NumberFormat(lang);
  const percent = new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 });

  const stats = [
    { label: tOverview("stats.accounts"), value: number.format(SAMPLE_ACCOUNTS.length) },
    { label: tOverview("stats.available"), value: number.format(5) },
    {
      label: tOverview("stats.requests"),
      value: number.format(SAMPLE_ACCOUNTS.reduce((sum, row) => sum + row.requests, 0)),
    },
    { label: tOverview("stats.successRate"), value: percent.format(0.994) },
  ];

  return (
    <div
      aria-hidden="true"
      className="relative mt-auto ml-[12%] min-h-0 flex-1 select-none overflow-hidden rounded-tl-2xl border-white/15 border-t border-l bg-card text-card-foreground shadow-2xl shadow-black/40"
    >
      <div className="flex min-w-[40rem] flex-col gap-6 p-7">
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

        <div className="flex flex-col gap-4">
          <p className="font-heading font-semibold text-xl">{tAccounts("title")}</p>
          <dl className="grid grid-cols-4 gap-3">
            {stats.map((stat) => (
              <div className="rounded-xl border bg-background/60 px-3.5 py-3" key={stat.label}>
                <dt className="truncate text-muted-foreground text-xs">{stat.label}</dt>
                <dd className="mt-1 font-semibold text-lg tabular-nums">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </div>

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
