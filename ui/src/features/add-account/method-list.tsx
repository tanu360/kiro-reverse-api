import {
  CodeIcon,
  CookieIcon,
  FolderOpenIcon,
  ShieldHalfIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, type ReactNode, useId } from "react";
import { AwsLogo, MicrosoftLogo } from "@/components/shared/brand-logos";
import { IconChip } from "@/components/shared/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AddAccountMethod } from "./add-account-dialog";

interface MethodMeta {
  id: AddAccountMethod;
  group: "signIn" | "import";
  icon?: IconSvgElement;
  Logo?: typeof AwsLogo;
}

/** Every method, in rail order: the browser sign-ins, then the imports. */
const METHODS: ReadonlyArray<MethodMeta> = [
  { id: "builderid", group: "signIn", Logo: AwsLogo },
  { id: "iam", group: "signIn", Logo: AwsLogo },
  { id: "microsoft", group: "signIn", Logo: MicrosoftLogo },
  { id: "local", group: "import", icon: FolderOpenIcon },
  { id: "credentials", group: "import", icon: CodeIcon },
  { id: "sso", group: "import", icon: ShieldHalfIcon },
  { id: "cookie", group: "import", icon: CookieIcon },
  { id: "apikey", group: "import", icon: TerminalIcon },
];

const GROUPS = ["signIn", "import"] as const;

function meta(method: AddAccountMethod): MethodMeta {
  return METHODS.find((item) => item.id === method) ?? METHODS[0];
}

/** A method's mark: its brand logo, or its icon. */
function Mark({ method, className }: { method: AddAccountMethod; className?: string }): ReactNode {
  const { Logo, icon } = meta(method);
  if (Logo) return <Logo className={className} />;
  return icon ? <HugeiconsIcon aria-hidden="true" className={className} icon={icon} /> : null;
}

/** The method's name in the rail and the select: IAM Identity Center without its long suffix. */
function useMethodLabel(): (method: AddAccountMethod) => string {
  const { t } = useT("add-account");
  return (method) => (method === "iam" ? t("methods.iam.short") : t(`methods.${method}.title`));
}

/**
 * The methods as a side rail from sm up, grouped under Sign in and Import: each a row with its
 * mark and name, the open one filled. While a request runs only the open one stays enabled, like
 * the disabled close X.
 */
export function MethodRail({
  method,
  busy,
  onSelect,
}: {
  method: AddAccountMethod;
  busy: boolean;
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  const label = useMethodLabel();
  const id = useId();
  return (
    <nav
      aria-label={t("method")}
      className="flex w-60 shrink-0 flex-col overflow-y-auto border-border-subtle border-e bg-surface-inset p-3 max-sm:hidden"
    >
      {GROUPS.map((group) => (
        <div className="flex flex-col gap-0.5 not-first:mt-3" key={group}>
          <h3
            className="px-2.5 pt-1 pb-1.5 font-medium text-meta text-muted-foreground"
            id={`${id}-${group}`}
          >
            {t(`group.${group}`)}
          </h3>
          <ul aria-labelledby={`${id}-${group}`} className="flex flex-col gap-0.5">
            {METHODS.filter((item) => item.group === group).map((item) => {
              const current = item.id === method;
              return (
                <li key={item.id}>
                  <button
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex h-9 w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-start font-medium text-sm transition-colors focus-outline disabled:pointer-events-none disabled:opacity-64",
                      current
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    data-method={item.id}
                    disabled={busy && !current}
                    onClick={() => {
                      if (!current) onSelect(item.id);
                    }}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className="flex size-4 shrink-0 items-center justify-center"
                    >
                      <Mark className="size-4" method={item.id} />
                    </span>
                    <span className="min-w-0 truncate">{label(item.id)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** The method picker on phones, where there is no room for the rail: a select over the pane. */
export function MethodSelect({
  method,
  busy,
  onSelect,
}: {
  method: AddAccountMethod;
  busy: boolean;
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  const label = useMethodLabel();
  const items = METHODS.map((item) => ({ value: item.id, label: label(item.id) }));
  return (
    <Field className="mb-5 sm:hidden">
      <FieldLabel>{t("method")}</FieldLabel>
      <Select
        disabled={busy}
        items={items}
        onValueChange={(value) => {
          if (value && value !== method) onSelect(value as AddAccountMethod);
        }}
        value={method}
      >
        <SelectTrigger>
          <SelectValue>
            {(value: AddAccountMethod) => (
              <span className="flex min-w-0 items-center gap-2">
                <Mark className="size-4" method={value} />
                <span className="truncate">{label(value)}</span>
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              <Mark className="size-4" method={item.value} />
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

/**
 * The open method's heading at the top of the pane: its mark in a chip, its name (Builder ID
 * with the Recommended badge) and what it adds (or, in re-login mode, that it signs the account
 * in again), over a hairline.
 */
export function MethodHead({
  method,
  relogin = false,
}: {
  method: AddAccountMethod;
  relogin?: boolean;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <div className="mb-5 flex items-start gap-3.5 border-border-subtle border-b pb-5">
      <IconChip size="md">
        <Mark method={method} />
      </IconChip>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="font-semibold text-base">{t(`methods.${method}.title`)}</h3>
          {method === "builderid" ? (
            <Badge size="sm" tone="primary">
              {t("recommended")}
            </Badge>
          ) : null}
        </div>
        <p className="text-pretty text-muted-foreground text-sm">
          {relogin
            ? t("relogin.methodDescription", { method: t(`methods.${method}.title`) })
            : t(`methods.${method}.description`)}
        </p>
      </div>
    </div>
  );
}
