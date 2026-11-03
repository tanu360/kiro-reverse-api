import {
  createContext,
  type JSX,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { EMPTY } from "@/lib/format";
import { readStorage, writeStorage } from "@/lib/storage";

export const PRIVACY_STORAGE_KEY = "privacyMode";

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

interface PrivacyContextValue {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  toggle: () => void;
}

const PrivacyContext = createContext<PrivacyContextValue>({
  enabled: true,
  setEnabled() {},
  toggle() {},
});

/** Privacy mode is on unless the viewer turned it off. */
function storedPrivacy(): boolean {
  return readStorage(PRIVACY_STORAGE_KEY) !== "false";
}

export function PrivacyProvider(props: {
  children: ReactNode;
  initialEnabled?: boolean;
}): JSX.Element {
  const [enabled, setState] = useState<boolean>(() => props.initialEnabled ?? storedPrivacy());

  const setEnabled = useCallback((value: boolean) => {
    writeStorage(PRIVACY_STORAGE_KEY, value ? "true" : "false");
    setState(value);
  }, []);

  const toggle = useCallback(() => {
    setState((current) => {
      writeStorage(PRIVACY_STORAGE_KEY, current ? "false" : "true");
      return !current;
    });
  }, []);

  const value = useMemo(() => ({ enabled, setEnabled, toggle }), [enabled, setEnabled, toggle]);
  return <PrivacyContext.Provider value={value}>{props.children}</PrivacyContext.Provider>;
}

export function usePrivacy(): {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  toggle: () => void;
} {
  return useContext(PrivacyContext);
}

function maskLabel(label: string): string {
  return label.length <= 2 ? label : `${label.slice(0, 2)}***`;
}

/** Keeps the first 2 characters of the local part and of every domain label except the TLD. */
export function maskEmail(email: string): string {
  if (!email?.includes("@")) return email;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const labels = domain.split(".");
  if (labels.length < 2) return `${maskLabel(local)}@${domain}`;
  const tld = labels[labels.length - 1];
  return `${maskLabel(local)}@${[...labels.slice(0, -1).map(maskLabel), tld].join(".")}`;
}

/** Masks every email address inside free text (error messages, for example). */
export function maskEmailsInText(text: string): string {
  if (!text) return text;
  return text.replace(EMAIL_PATTERN, (email) => maskEmail(email));
}

/**
 * The email, masked when privacy is on. Without an email, the first 12 characters of the id
 * plus an ellipsis, or an em dash; that fallback is never masked.
 */
export function displayEmail(
  email: string | undefined,
  id: string | undefined,
  privacy: boolean,
): string {
  if (email) return privacy ? maskEmail(email) : email;
  return id ? `${id.slice(0, 12)}…` : EMPTY;
}

export function useDisplayEmail(): (email?: string, id?: string) => string {
  const { enabled } = usePrivacy();
  return useCallback((email?: string, id?: string) => displayEmail(email, id, enabled), [enabled]);
}

export function useMaskText(): (text?: string) => string {
  const { enabled } = usePrivacy();
  return useCallback(
    (text?: string) => (enabled ? maskEmailsInText(text ?? "") : (text ?? "")),
    [enabled],
  );
}
