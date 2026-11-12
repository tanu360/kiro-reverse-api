import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockDb } from "@/lib/mocks/db";
import { apiUrl } from "@/lib/mocks/http";
import { mockServer } from "@/lib/mocks/node";
import { renderWithProviders } from "@/test/render";
import { SECTION_ID } from "./sections";
import { UpstreamCard } from "./upstream-card";

let posts: Array<Promise<unknown>> = [];

function onRequestStart({ request }: { request: Request }): void {
  if (request.method === "POST" && new URL(request.url).pathname.endsWith("/upstream")) {
    posts.push(request.clone().json());
  }
}

beforeEach(() => {
  posts = [];
  mockServer.events.on("request:start", onRequestStart);
});

afterEach(() => {
  mockServer.events.removeListener("request:start", onRequestStart);
});

async function renderCard() {
  const result = renderWithProviders(<UpstreamCard />);
  await screen.findByRole("combobox", { name: "API domain" });
  const card = document.getElementById(SECTION_ID.upstream);
  if (!card) throw new Error("upstream card not rendered");
  return { ...result, card };
}

describe("UpstreamCard", () => {
  it("shows amazonaws and Automatic by default", async () => {
    const { card } = await renderCard();
    expect(within(card).getByRole("combobox", { name: "API domain" })).toHaveTextContent(
      "AWS (amazonaws.com)",
    );
    expect(within(card).getByRole("combobox", { name: "API region" })).toHaveTextContent(
      "Automatic",
    );
    expect(within(card).getByLabelText("Sign-in region")).toHaveValue("");
    expect(within(card).getByText("q.<region>.amazonaws.com")).toBeInTheDocument();
  });

  it("sends kiro with eu-central-1 and an empty auth region", async () => {
    const { user, card } = await renderCard();

    await user.click(within(card).getByRole("combobox", { name: "API domain" }));
    await user.click(await screen.findByRole("option", { name: "Kiro (kiro.dev)" }));
    await user.click(within(card).getByRole("combobox", { name: "API region" }));
    await user.click(await screen.findByRole("option", { name: "eu-central-1" }));
    expect(within(card).getByText("runtime.eu-central-1.kiro.dev")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await Promise.all(posts)).toEqual([
      { apiDomain: "kiro", apiRegion: "eu-central-1", authRegion: "" },
    ]);
    expect(mockDb.upstream).toEqual({
      apiDomain: "kiro",
      apiRegion: "eu-central-1",
      authRegion: "",
    });
  });

  it("sends a typed sign-in region lowercased", async () => {
    const { user, card } = await renderCard();

    await user.type(within(card).getByLabelText("Sign-in region"), " EU-West-1 ");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Your settings were saved.")).toBeInTheDocument();
    expect(await Promise.all(posts)).toEqual([
      { apiDomain: "amazonaws", apiRegion: "", authRegion: "eu-west-1" },
    ]);
  });

  it("rejects a malformed sign-in region without a request", async () => {
    const { user, card } = await renderCard();
    const input = within(card).getByLabelText("Sign-in region");

    await user.type(input, "evil.example/x");
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(
      await within(card).findByText("Enter an AWS region code, such as us-east-1."),
    ).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(posts).toHaveLength(0);

    // Typing again clears the error.
    await user.type(input, "1");
    await waitFor(() =>
      expect(
        within(card).queryByText("Enter an AWS region code, such as us-east-1."),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the server error for an invalid domain", async () => {
    mockServer.use(
      http.post(apiUrl("/upstream"), () =>
        HttpResponse.json(
          { error: "Invalid apiDomain, must be: amazonaws or kiro", code: "invalid_api_domain" },
          { status: 400 },
        ),
      ),
    );
    const { user, card } = await renderCard();

    await user.click(within(card).getByRole("combobox", { name: "API domain" }));
    await user.click(await screen.findByRole("option", { name: "Kiro (kiro.dev)" }));
    await user.click(within(card).getByRole("button", { name: "Save" }));

    expect(
      (
        await screen.findAllByText(
          "Could not save settings: Choose an API domain: amazonaws or kiro.",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(mockDb.upstream.apiDomain).toBe("amazonaws");
  });
});
