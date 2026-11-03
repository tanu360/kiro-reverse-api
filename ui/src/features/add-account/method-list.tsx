import {
  Building2Icon,
  ChevronRightIcon,
  CodeIcon,
  CookieIcon,
  FolderOpenIcon,
  IdCardIcon,
  KeyRoundIcon,
  type LucideIcon,
  ShieldHalfIcon,
  TerminalIcon,
} from "lucide-react";
import type { JSX } from "react";
import { useT } from "@/lib/i18n";
import type { AddAccountMethod } from "./add-account-dialog";
import { FlowFooter } from "./flow-context";

export const METHODS: ReadonlyArray<{ id: AddAccountMethod; icon: LucideIcon }> = [
  { id: "builderid", icon: IdCardIcon },
  { id: "iam", icon: KeyRoundIcon },
  { id: "microsoft", icon: Building2Icon },
  { id: "sso", icon: ShieldHalfIcon },
  { id: "local", icon: FolderOpenIcon },
  { id: "credentials", icon: CodeIcon },
  { id: "cookie", icon: CookieIcon },
  { id: "apikey", icon: TerminalIcon },
];

export function MethodList({
  onSelect,
}: {
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <>
      <ul className="flex flex-col gap-2">
        {METHODS.map(({ id, icon: Icon }) => (
          <li key={id}>
            <button
              className="flex w-full min-h-14 cursor-pointer items-center gap-3 rounded-xl border bg-card px-3 py-3 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-method={id}
              onClick={() => onSelect(id)}
              type="button"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon aria-hidden="true" className="size-4.5" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium text-sm">{t(`methods.${id}.title`)}</span>
                <span className="text-muted-foreground text-xs">
                  {t(`methods.${id}.description`)}
                </span>
              </span>
              <ChevronRightIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
            </button>
          </li>
        ))}
      </ul>
      <FlowFooter hideBack />
    </>
  );
}
