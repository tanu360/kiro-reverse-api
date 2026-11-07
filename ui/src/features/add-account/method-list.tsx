import {
  Building06Icon,
  CodeIcon,
  CookieIcon,
  FolderOpenIcon,
  IdCardIcon,
  KeyRoundIcon,
  ShieldHalfIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { JSX } from "react";
import { ChoiceTile } from "@/components/shared/choice-card";
import { Badge } from "@/components/ui/badge";
import { useT } from "@/lib/i18n";
import type { AddAccountMethod } from "./add-account-dialog";
import { FlowFooter } from "./flow-context";

export const METHODS: ReadonlyArray<{ id: AddAccountMethod; icon: IconSvgElement }> = [
  { id: "builderid", icon: IdCardIcon },
  { id: "iam", icon: KeyRoundIcon },
  { id: "microsoft", icon: Building06Icon },
  { id: "sso", icon: ShieldHalfIcon },
  { id: "local", icon: FolderOpenIcon },
  { id: "credentials", icon: CodeIcon },
  { id: "cookie", icon: CookieIcon },
  { id: "apikey", icon: TerminalIcon },
];

/** Sign in through a provider, or import credentials the user already has. */
const GROUPS: ReadonlyArray<{ id: "signIn" | "import"; methods: AddAccountMethod[] }> = [
  { id: "signIn", methods: ["builderid", "iam", "microsoft"] },
  { id: "import", methods: ["sso", "local", "credentials", "cookie", "apikey"] },
];

const ICON = Object.fromEntries(METHODS.map(({ id, icon }) => [id, icon])) as Record<
  AddAccountMethod,
  IconSvgElement
>;

/**
 * The eight ways to add an account as tiles in two labelled groups: sign in with a provider
 * (AWS Builder ID first, full width and marked recommended) and import credentials. Two
 * columns from sm up, one on phones; a group's odd last tile spans both columns, so every row
 * is even.
 */
export function MethodList({
  onSelect,
}: {
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <>
      <div className="flex flex-col gap-5">
        {GROUPS.map((group) => {
          const headingId = `add-account-group-${group.id}`;
          return (
            <section aria-labelledby={headingId} className="flex flex-col gap-2" key={group.id}>
              <h3 className="font-medium text-meta text-muted-foreground" id={headingId}>
                {t(`groups.${group.id}`)}
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.methods.map((id, index) => {
                  const featured = id === "builderid";
                  const rest = featured
                    ? index
                    : index - (group.methods.includes("builderid") ? 1 : 0);
                  const count =
                    group.methods.length - (group.methods.includes("builderid") ? 1 : 0);
                  const oddLast = !featured && count % 2 === 1 && rest === count - 1;
                  return (
                    <ChoiceTile
                      badge={
                        featured ? (
                          <Badge size="sm" tone="primary">
                            {t("recommended")}
                          </Badge>
                        ) : undefined
                      }
                      data-method={id}
                      description={t(`methods.${id}.description`)}
                      icon={ICON[id]}
                      key={id}
                      onClick={() => onSelect(id)}
                      title={t(`methods.${id}.title`)}
                      wide={featured || oddLast}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <FlowFooter />
    </>
  );
}
