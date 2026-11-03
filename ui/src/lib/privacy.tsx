import type { JSX, ReactNode } from "react";

export const PRIVACY_STORAGE_KEY = "privacyMode";

// Skeleton: Task 3 implements privacy mode and masking. The mask functions return their input.

export function PrivacyProvider(props: {
  children: ReactNode;
  initialEnabled?: boolean;
}): JSX.Element {
  return <>{props.children}</>;
}

export function usePrivacy(): {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  toggle: () => void;
} {
  return { enabled: true, setEnabled() {}, toggle() {} };
}

export function maskEmail(email: string): string {
  return email;
}

export function maskEmailsInText(text: string): string {
  return text;
}

export function displayEmail(
  email: string | undefined,
  id: string | undefined,
  _privacy: boolean,
): string {
  return email || id || "";
}

export function useDisplayEmail(): (email?: string, id?: string) => string {
  return (email, id) => email || id || "";
}

export function useMaskText(): (text?: string) => string {
  return (text) => text ?? "";
}
