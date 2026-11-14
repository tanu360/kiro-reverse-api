import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TOKEN_KEY } from "@/lib/auth/session";
import { mockDb } from "@/lib/mocks/db";
import { MOCK_TOTP_SECRET, totpCodeAt, totpStep } from "@/lib/mocks/totp";
import { renderApp } from "@/test/render";

const PASSWORD = "12345678";

/** Two-factor sign-in on, with the mock's secret and two recovery codes. */
function turnOn(): void {
  Object.assign(mockDb.twoFactor, {
    enabled: true,
    enabledAt: Date.now(),
    secret: MOCK_TOTP_SECRET,
    recovery: ["abcde-23456", "fghjk-34567"],
    lastStep: 0,
  });
}

async function passwordStep() {
  const app = await renderApp("/login", { authed: false });
  await app.user.type(screen.getByLabelText("Password"), PASSWORD);
  await app.user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Enter the 6-digit code from your authenticator app.");
  return app;
}

function stored(): string | null {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
}

beforeEach(() => {
  mockDb.firstRunPending = false;
  turnOn();
});

describe("sign-in with two-factor on", () => {
  it("asks for a code after the password, and signs in with it", async () => {
    const { user } = await passwordStep();
    expect(stored()).toBeNull();
    const field = screen.getByLabelText("Code from the app");
    expect(field).toHaveAttribute("autocomplete", "one-time-code");
    expect(field).toHaveAttribute("inputmode", "numeric");
    expect(field).toHaveFocus();
    await user.type(field, await totpCodeAt(MOCK_TOTP_SECRET, totpStep()));
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(stored()).toMatch(/^mock-/));
  });

  it("refuses a wrong code and a code used before", async () => {
    const { user } = await passwordStep();
    const field = screen.getByLabelText("Code from the app");
    await user.type(field, "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      await screen.findByText("That code is not right. Check that your phone's clock is correct."),
    ).toBeInTheDocument();

    // The code the next sign-in already used is refused.
    const code = await totpCodeAt(MOCK_TOTP_SECRET, totpStep());
    mockDb.twoFactor.lastStep = totpStep() + 1;
    await user.clear(field);
    await user.type(field, code);
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      await screen.findByText("This code was used already. Wait for the next one."),
    ).toBeInTheDocument();
    expect(stored()).toBeNull();
  });

  it("signs in with a recovery code once", async () => {
    const { user } = await passwordStep();
    await user.click(screen.getByRole("button", { name: "Use a recovery code" }));
    const field = screen.getByLabelText("Recovery code");
    expect(field).toHaveAttribute("inputmode", "text");
    await user.type(field, "ABCDE23456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(stored()).toMatch(/^mock-/));
    expect(mockDb.twoFactor.recovery).toEqual(["fghjk-34567"]);
  });

  it("goes back to the password when the sign-in timed out", async () => {
    const { user } = await passwordStep();
    mockDb.twoFactor.challenges = {};
    await user.type(screen.getByLabelText("Code from the app"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      await screen.findByText("The sign-in timed out. Enter the password again."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("counts wrong codes against the guess limit and ends the sign-in after five", async () => {
    const { user } = await passwordStep();
    const field = screen.getByLabelText("Code from the app");
    for (let i = 1; i <= 4; i++) {
      await user.clear(field);
      await user.type(field, "000000");
      await user.click(screen.getByRole("button", { name: "Verify" }));
      await waitFor(() => expect(mockDb.failedLogins).toBe(i));
    }
    await user.clear(field);
    await user.type(field, "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(mockDb.failedLogins).toBe(5));
    // The fifth wrong code used up this sign-in, and the shared budget too.
    await user.clear(field);
    await user.type(field, "000000");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(
      await screen.findByText("The sign-in timed out. Enter the password again."),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText("Password"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Too many attempts\. Try again in \d+s\./)).toBeInTheDocument();
  });
});
