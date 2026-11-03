import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  displayEmail,
  maskEmail,
  maskEmailsInText,
  PRIVACY_STORAGE_KEY,
  PrivacyProvider,
  useDisplayEmail,
  useMaskText,
  usePrivacy,
} from "./privacy";

describe("maskEmail", () => {
  it("keeps 2 characters of the local part and of each label except the TLD", () => {
    expect(maskEmail("alice@mail.example.com")).toBe("al***@ma***.ex***.com");
  });

  it("leaves short parts unchanged", () => {
    expect(maskEmail("ab@cd.io")).toBe("ab@cd.io");
  });

  it("returns text without an @ unchanged", () => {
    expect(maskEmail("api-key-3f9a1c0b7e2d")).toBe("api-key-3f9a1c0b7e2d");
    expect(maskEmail("")).toBe("");
  });
});

describe("maskEmailsInText", () => {
  it("masks every email in a sentence", () => {
    expect(
      maskEmailsInText("quota for dana@northwind.com, then retried on bob.smith@contoso.org"),
    ).toBe("quota for da***@no***.com, then retried on bo***@co***.org");
  });
});

describe("displayEmail", () => {
  it("masks a real email only when privacy is on", () => {
    expect(displayEmail("alice@mail.example.com", "id", true)).toBe("al***@ma***.ex***.com");
    expect(displayEmail("alice@mail.example.com", "id", false)).toBe("alice@mail.example.com");
  });

  it("falls back to the id prefix, never masked", () => {
    expect(displayEmail("", "abcdef1234567890", true)).toBe("abcdef123456…");
  });

  it("shows an em dash when both are empty", () => {
    expect(displayEmail("", "", true)).toBe("—");
    expect(displayEmail(undefined, undefined, false)).toBe("—");
  });
});

function Probe() {
  const { enabled, toggle } = usePrivacy();
  const show = useDisplayEmail();
  const mask = useMaskText();
  return (
    <div>
      <p data-testid="state">{String(enabled)}</p>
      <p data-testid="email">{show("alice@mail.example.com")}</p>
      <p data-testid="text">{mask("error for alice@mail.example.com")}</p>
      <button type="button" onClick={toggle}>
        toggle
      </button>
    </div>
  );
}

describe("PrivacyProvider", () => {
  it("is on by default and persists the toggle", async () => {
    render(
      <PrivacyProvider>
        <Probe />
      </PrivacyProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("true");
    expect(screen.getByTestId("email")).toHaveTextContent("al***@ma***.ex***.com");
    expect(screen.getByTestId("text")).toHaveTextContent("error for al***@ma***.ex***.com");

    await userEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(screen.getByTestId("state")).toHaveTextContent("false");
    expect(screen.getByTestId("email")).toHaveTextContent("alice@mail.example.com");
    expect(localStorage.getItem(PRIVACY_STORAGE_KEY)).toBe("false");
  });

  it("reads a stored 'false'", () => {
    localStorage.setItem(PRIVACY_STORAGE_KEY, "false");
    render(
      <PrivacyProvider>
        <Probe />
      </PrivacyProvider>,
    );
    expect(screen.getByTestId("state")).toHaveTextContent("false");
  });
});
