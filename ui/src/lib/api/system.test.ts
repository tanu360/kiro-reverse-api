import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { mockServer } from "@/lib/mocks/node";
import { ApiError } from "./errors";
import { fetchReleaseReady, RELEASE_API_URL } from "./system";

/** Answers the release lookup for any tag with `body` (or `status` with no body). */
function release(response: () => Response) {
  mockServer.use(http.get(`${RELEASE_API_URL}/:tag`, response));
}

describe("fetchReleaseReady", () => {
  it("is ready once SHA256SUMS.txt is uploaded, asking for the bare tag", async () => {
    let asked = "";
    mockServer.use(
      http.get(`${RELEASE_API_URL}/:tag`, ({ params }) => {
        asked = String(params.tag);
        return HttpResponse.json({
          assets: [
            { name: "kiro-proxy-linux-amd64.tar.gz", state: "uploaded" },
            { name: "SHA256SUMS.txt", state: "uploaded" },
          ],
        });
      }),
    );
    await expect(fetchReleaseReady("v4.0.3")).resolves.toBe(true);
    expect(asked).toBe("4.0.3");
  });

  it("is not ready before the release exists", async () => {
    release(() => HttpResponse.json({ message: "Not Found" }, { status: 404 }));
    await expect(fetchReleaseReady("4.0.3")).resolves.toBe(false);
  });

  it("is not ready while the checksums are missing or still uploading", async () => {
    release(() => HttpResponse.json({ assets: [] }));
    await expect(fetchReleaseReady("4.0.3")).resolves.toBe(false);
    release(() => HttpResponse.json({ assets: [{ name: "SHA256SUMS.txt", state: "starter" }] }));
    await expect(fetchReleaseReady("4.0.3")).resolves.toBe(false);
  });

  it("fails on any other answer, such as the API's rate limit", async () => {
    release(() => new HttpResponse(null, { status: 403 }));
    await expect(fetchReleaseReady("4.0.3")).rejects.toBeInstanceOf(ApiError);
  });
});
