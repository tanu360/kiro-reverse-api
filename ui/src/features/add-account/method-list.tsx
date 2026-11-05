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
import { ChoiceList, ChoiceRow } from "@/components/shared/choice-card";
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

/** The eight ways to add an account, as one divided card of rows that open their flow. */
export function MethodList({
  onSelect,
}: {
  onSelect: (method: AddAccountMethod) => void;
}): JSX.Element {
  const { t } = useT("add-account");
  return (
    <>
      <ChoiceList>
        {METHODS.map(({ id, icon }) => (
          <ChoiceRow
            data-method={id}
            description={t(`methods.${id}.description`)}
            icon={icon}
            key={id}
            onClick={() => onSelect(id)}
            title={t(`methods.${id}.title`)}
          />
        ))}
      </ChoiceList>
      <FlowFooter />
    </>
  );
}
