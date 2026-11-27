import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
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
    // The key to type waits behind "Can't scan?".
    expect(within(dialog).queryByText("MZXW6YTBOI4DGNJQGEZTSMBVGM2DONZY")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Can't scan? Use the setup key" }));
    expect(within(dialog).getByText("MZXW6YTBOI4DGNJQGEZTSMBVGM2DONZY")).toBeInTheDocument();

    const field = within(dialog).getByLabelText("Code from the app");
    // Digits only, six at most: letters and the space of a pasted "123 456" never show.
    await user.type(field, "1a2 3b45-678");
    expect(field).toHaveValue("123456");
    await user.clear(field);
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
    // Turn on is gone with the dialog: focus goes to Turn off, which took its place.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn off" })).toHaveFocus());
  });

  it("retries a setup that failed to start, and leaves the code field unfocused", async () => {
    mockServer.use(
      http.post(apiUrl("/two-factor/setup"), () => HttpResponse.json({}, { status: 500 }), {
        once: true,
      }),
    );
    const { user } = renderWithProviders(<TwoFactorCard />);
    await user.click(await screen.findByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeDisabled();
    await user.click(await within(dialog).findByRole("button", { name: "Try again" }));
    expect(
      await within(dialog).findByRole("img", { name: "QR code for your authenticator app" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Turn on" })).toBeEnabled();
    expect(within(dialog).getByLabelText("Code from the app")).not.toHaveFocus();
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
    // Turn off is gone with the dialog: focus goes to Turn on, which took its place.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Turn on" })).toHaveFocus());
  });

  it("says why setup is off while ADMIN_RESET_2FA is set", async () => {
    mockDb.twoFactor.resetByEnv = true;
    renderWithProviders(<TwoFactorCard />);
    expect(
      await screen.findByText(/ADMIN_RESET_2FA turns it off at each start/),
    ).toBeInTheDocument();
    expect(screen.getByText("Set by ADMIN_RESET_2FA")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeDisabled();
  });
});
