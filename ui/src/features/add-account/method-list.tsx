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

/** The eight methods in four pairs by where the credentials come from. */
const GROUPS: ReadonlyArray<{
  id: "aws" | "browser" | "kiro" | "files";
  methods: [AddAccountMethod, AddAccountMethod];
}> = [
  { id: "aws", methods: ["builderid", "iam"] },
  { id: "browser", methods: ["microsoft", "sso"] },
  { id: "kiro", methods: ["local", "cookie"] },
  { id: "files", methods: ["credentials", "apikey"] },
];

const ICON = Object.fromEntries(METHODS.map(({ id, icon }) => [id, icon])) as Record<
  AddAccountMethod,
  IconSvgElement
>;

/**
 * The eight ways to add an account, side by side in four labelled pairs (AWS sign-in, browser
 * sign-in, from Kiro, keys and exports): two equal tiles per row at every width. AWS Builder ID
 * carries the Recommended badge. On phones a tile is its icon over its name; from sm up the
 * description shows beside the icon.
 */
export function MethodList({
  onSelect,
}: {
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <>
      <div className="flex flex-col gap-4">
        {GROUPS.map((group) => {
          const headingId = `add-account-group-${group.id}`;
          return (
            <section aria-labelledby={headingId} className="flex flex-col gap-2" key={group.id}>
              <h3 className="font-medium text-meta text-muted-foreground" id={headingId}>
                {t(`groups.${group.id}`)}
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {group.methods.map((id) => (
                  <ChoiceTile
                    badge={
                      id === "builderid" ? (
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
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <FlowFooter />
    </>
  );
}
