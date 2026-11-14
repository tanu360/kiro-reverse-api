import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { MOCK_TOTP_SECRET, totpCodeAt, totpStep } from "@/lib/mocks/totp";
import { renderWithProviders } from "@/test/render";
import { TwoFactorCard } from "./two-factor-card";

describe("TwoFactorCard", () => {
  it("turns on with a QR code, a confirming code and recovery codes shown once", async () => {
    const { user } = renderWithProviders(<TwoFactorCard />);
    await user.click(await screen.findByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("MZXW 6YTB OI4D GNJQ GEZT SMBV GM2D ONZY")).toBeInTheDocument();

    const field = within(dialog).getByLabelText("Code from the app");
    await user.type(field, "000000");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(
      await within(dialog).findByText(
        "That code is not right. Check that your phone's clock is correct.",
      ),
    ).toBeInTheDocument();
    expect(mockDb.twoFactor.enabled).toBe(false);

    await user.clear(field);
    await user.type(field, await totpCodeAt(MOCK_TOTP_SECRET, totpStep()));
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(await within(dialog).findByText("Save your recovery codes")).toBeInTheDocument();
    const codes = within(dialog).getByRole("list", { name: "Recovery codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    expect(mockDb.twoFactor.enabled).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "I saved them" }));
    expect(
      await screen.findByText("10 unused codes left. Each code signs in once without the app."),
    ).toBeInTheDocument();
  });

  it("turns off with the password", async () => {
    Object.assign(mockDb.twoFactor, {
      enabled: true,
      enabledAt: Date.now(),
      secret: MOCK_TOTP_SECRET,
      recovery: ["abcde-23456"],
    });
    const { user } = renderWithProviders(<TwoFactorCard />);
    // One code left: the card asks for new ones.
    expect(await screen.findByText(/almost out of recovery codes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Turn off" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Use the password instead" }));
    await user.type(within(dialog).getByLabelText("Admin password"), "wrong-password");
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect(await within(dialog).findByText("Incorrect password.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText("Admin password"));
    await user.type(within(dialog).getByLabelText("Admin password"), "12345678");
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(mockDb.twoFactor.enabled).toBe(false));
    expect(await screen.findByRole("button", { name: "Turn on" })).toBeInTheDocument();
  });

  it("says why setup is off while ADMIN_RESET_2FA is set", async () => {
    mockDb.twoFactor.resetByEnv = true;
    renderWithProviders(<TwoFactorCard />);
    expect(await screen.findByText(/ADMIN_RESET_2FA is set on the server/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
  });
});
