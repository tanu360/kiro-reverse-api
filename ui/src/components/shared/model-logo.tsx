import { CubeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { modelOrigin } from "@/lib/model-maker";
import { cn } from "@/lib/utils";
import { KiroLogo } from "./brand-logos";
import { MODEL_MAKERS, type ModelMaker } from "./model-logos";

const BOX = "inline-flex size-4 shrink-0 items-center justify-center";

/**
 * A model maker's mark beside text that already names it: hidden from screen readers, with the
 * maker's name as a tooltip.
 */
export function MakerLogo({
  maker,
  className,
}: {
  maker: ModelMaker;
  className?: string;
}): JSX.Element {
  const { name, Mark } = MODEL_MAKERS[maker];
  return (
    <span aria-hidden="true" className={cn(BOX, className)} title={name}>
      <Mark className="size-full" />
    </span>
  );
}

/**
 * The mark of the company behind a model name, next to the name: decorative (the name says it),
 * with the company in a tooltip. A name that gives no company away gets a plain cube.
 */
export function ModelLogo({
  model,
  className,
}: {
  model: string;
  className?: string;
}): JSX.Element {
  const origin = modelOrigin(model);
  const box = cn(BOX, className);
  if (origin === "kiro") {
    return (
      <span aria-hidden="true" className={box} title="Kiro">
        <KiroLogo className="size-full" />
      </span>
    );
  }
  if (origin) return <MakerLogo className={className} maker={origin} />;
  return (
    <span aria-hidden="true" className={cn(box, "text-muted-foreground/70")}>
      <HugeiconsIcon className="size-full" icon={CubeIcon} />
    </span>
  );
}
