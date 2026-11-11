import {
  CodeIcon,
  CookieIcon,
  FolderOpenIcon,
  ShieldHalfIcon,
  TerminalIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type JSX, useId } from "react";
import { AwsLogo, MicrosoftLogo } from "@/components/shared/brand-logos";
import { ChoiceList, ChoiceRow } from "@/components/shared/choice-card";
import { IconChip } from "@/components/shared/icon-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AddAccountMethod } from "./add-account-dialog";

/** What a method asks of the user, shown under its name in the list. */
type MethodKind = "browser" | "file" | "token" | "key";

/** Every way but Builder ID, which has the recommended card above them. */
const OTHER_WAYS: ReadonlyArray<{
  id: AddAccountMethod;
  kind: MethodKind;
  icon?: IconSvgElement;
  Logo?: typeof AwsLogo;
}> = [
  { id: "iam", kind: "browser", Logo: AwsLogo },
  { id: "microsoft", kind: "browser", Logo: MicrosoftLogo },
  { id: "local", kind: "file", icon: FolderOpenIcon },
  { id: "credentials", kind: "file", icon: CodeIcon },
  { id: "sso", kind: "token", icon: ShieldHalfIcon },
  { id: "cookie", kind: "token", icon: CookieIcon },
  { id: "apikey", kind: "key", icon: TerminalIcon },
];

/** The browser sign-ins; every other method imports credentials the user already has. */
const SIGN_IN_METHODS: ReadonlySet<AddAccountMethod> = new Set(["builderid", "iam", "microsoft"]);

const STEP_MARK = {
  done: "bg-info-surface text-info-foreground",
  current: "bg-primary text-primary-foreground",
  todo: "border border-border text-muted-foreground",
} as const;

/**
 * The wizard's progress line under the title: choose a method, sign in (or import), done. On the
 * list the first step is current; inside a method the first is ticked and the second current.
 * The last never shows as current: the dialog closes once the account is added.
 */
export function MethodStepper({ method }: { method: AddAccountMethod | null }): JSX.Element {
  const { t } = useT("add-account");
  const at = method ? 1 : 0;
  const labels = [
    t("stepper.choose"),
    method && !SIGN_IN_METHODS.has(method) ? t("stepper.import") : t("stepper.signIn"),
    t("stepper.done"),
  ];
  return (
    <ol aria-label={t("stepper.label")} className="mt-2 flex items-center gap-2">
      {labels.map((label, index) => {
        const state = index < at ? "done" : index === at ? "current" : "todo";
        return (
          <li
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2 font-medium text-meta",
              state === "current" ? "text-foreground" : "text-muted-foreground",
              // The rule to the next step.
              index < labels.length - 1 && "after:h-px after:w-6 after:bg-border sm:after:w-8",
            )}
            key={label}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full font-semibold text-2xs tabular-nums",
                STEP_MARK[state],
              )}
            >
              {state === "done" ? (
                <HugeiconsIcon className="size-3" icon={Tick02Icon} strokeWidth={2} />
              ) : (
                index + 1
              )}
            </span>
            {/* On phones only the current step keeps its label; the others are their numbers. */}
            <span className={cn("truncate", state !== "current" && "max-sm:sr-only")}>
              {label}
              {state === "done" ? <span className="sr-only"> {t("stepDone")}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The eight ways to add an account, guided: AWS Builder ID, the usual way in, as one recommended
 * card that says what happens and has its own button; the other seven under "Other ways" as one
 * list of rows, each naming what it asks for (a browser sign-in, a file, a token, a key).
 */
export function MethodList({
  onSelect,
}: {
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  const otherWaysId = useId();
  return (
    <div className="flex flex-col gap-5">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <IconChip size="lg">
            <AwsLogo />
          </IconChip>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="font-semibold text-base">{t("methods.builderid.title")}</h3>
              <Badge size="sm" tone="primary">
                {t("recommended")}
              </Badge>
            </div>
            <p className="text-muted-foreground text-sm">{t("methods.builderid.description")}</p>
          </div>
        </div>
        <p className="text-muted-foreground text-sm">{t("builderid.startNote")}</p>
        <Button className="w-full" data-method="builderid" onClick={() => onSelect("builderid")}>
          {t("continueWith", { name: t("methods.builderid.title") })}
        </Button>
      </Card>
      <section aria-labelledby={otherWaysId} className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 font-medium text-meta" id={otherWaysId}>
          {t("otherWays")}
          <span className="font-normal text-muted-foreground tabular-nums">
            {OTHER_WAYS.length}
          </span>
        </h3>
        <ChoiceList>
          {OTHER_WAYS.map(({ id, kind, icon, Logo }) => (
            <ChoiceRow
              data-method={id}
              description={t(`kind.${kind}`)}
              icon={icon}
              key={id}
              mark={Logo ? <Logo /> : undefined}
              onClick={() => onSelect(id)}
              title={t(`methods.${id}.title`)}
            />
          ))}
        </ChoiceList>
      </section>
    </div>
  );
}
