import { type JSX, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import type { DemoKeyInfo } from "@/features/user-panel/mocks";
import { useT } from "@/lib/i18n";

/**
 * The mock server's demo keys under the key sign-in form, one per state of the user panel
 * (features/user-panel/mocks.ts lists what each shows). Picking one hands its value to `onPick`.
 * Outside mock mode it renders nothing; the list is imported only behind that check, so neither
 * the keys nor the mock module reach a production build.
 */
export function MockDemoKeys({ onPick }: { onPick: (key: string) => void }): JSX.Element | null {
  if (import.meta.env.VITE_MOCK !== "1") return null;
  return <DemoKeyList onPick={onPick} />;
}

function DemoKeyList({ onPick }: { onPick: (key: string) => void }): JSX.Element | null {
  const { t } = useT("user-auth");
  const headingId = useId();
  const [keys, setKeys] = useState<readonly DemoKeyInfo[]>([]);

  useEffect(() => {
    let live = true;
    // Already loaded with the mock handlers, so this resolves at once.
    void import("@/features/user-panel/mocks").then((mocks) => {
      if (live) setKeys(mocks.DEMO_KEYS);
    });
    return () => {
      live = false;
    };
  }, []);

  if (keys.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-2 text-muted-foreground text-sm"
    >
      <h2 className="font-medium" id={headingId}>
        {t("demoKeys.title")}
      </h2>
      <p>{t("demoKeys.description")}</p>
      <ul className="flex flex-col gap-1">
        {keys.map(({ id, key }) => (
          <li key={id}>
            <Button onClick={() => onPick(key)} type="button" variant="link-inline">
              {t(`demoKeys.${id}.label`)}
            </Button>
            <span aria-hidden="true" className="mx-1.5">
              ·
            </span>
            {t(`demoKeys.${id}.description`)}
          </li>
        ))}
      </ul>
    </section>
  );
}
