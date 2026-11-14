/*
 * What a field keeps as it is typed or pasted, for values with a fixed alphabet: a character the
 * value can never hold never shows, instead of an error after Save. Free text (names, notes,
 * URLs, JSON) is not filtered.
 */

/** Digits only, at most `max` of them when given (a port, a two-factor code). */
export function digitsOnly(value: string, max?: number): string {
  const digits = value.replace(/\D/g, "");
  return max === undefined ? digits : digits.slice(0, max);
}

/** No whitespace anywhere: a model ID, a model suffix or an API key never holds a space. */
export function noSpaces(value: string): string {
  return value.replace(/\s/g, "");
}

/** An AWS region code ("eu-central-1"): lowercase letters, digits and hyphens. */
export function regionChars(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "");
}

/** A machine ID (a UUID or 32 hex digits): hex digits and hyphens. */
export function hexChars(value: string): string {
  return value.replace(/[^0-9a-fA-F-]/g, "");
}

/** An HTTP header name: the token characters of RFC 9110 (letters, digits, ! # $ % & ' * + - . ^ _ ` | ~). */
export function headerNameChars(value: string): string {
  return value.replace(/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/g, "");
}

/** A two-factor recovery code ("k7xq2-m9fd4"): letters, digits and hyphens. */
export function recoveryCodeChars(value: string): string {
  return value.replace(/[^0-9A-Za-z-]/g, "");
}
