import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/render";
import { SignInReasonNotice } from "./sign-in-reason";

describe("SignInReasonNotice", () => {
  it("names the backup's password after a restore", () => {
    renderWithProviders(<SignInReasonNotice reason="restored" />);
    expect(
      screen.getByText("Backup restored. Sign in with the password stored in the backup."),
    ).toBeInTheDocument();
  });

  // config/backup.go writeRestoredConfig keeps ADMIN_PASSWORD over the backup's password.
  it("names the ADMIN_PASSWORD password when the restore kept it", () => {
    renderWithProviders(<SignInReasonNotice reason="restoredEnvPassword" />);
    expect(
      screen.getByText(
        "Backup restored. Sign in with the ADMIN_PASSWORD password: the restore kept it, not the backup's.",
      ),
    ).toBeInTheDocument();
  });
});
