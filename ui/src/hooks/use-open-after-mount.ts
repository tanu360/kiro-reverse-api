import { useEffect, useState } from "react";

/**
 * Base UI plays a popup's enter transition only when `open` turns true after the popup's root has
 * mounted. A dialog or sheet that mounts already open (a fresh key per opening, as the account
 * sheet and the Test dialog do) would appear without it, while its close still animated. So the
 * first render reports it closed and the next one opens it. `undefined` (uncontrolled) passes
 * through.
 */
export function useOpenAfterMount(open: boolean | undefined): boolean | undefined {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return open === undefined ? undefined : open && mounted;
}
