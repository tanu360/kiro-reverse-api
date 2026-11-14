import { describe, expect, it } from "vitest";
import { MOCK_TOTP_QR_SVG } from "@/lib/mocks/totp";
import { parseQrSvg } from "./styled-qr";

describe("parseQrSvg", () => {
  it("reads the server's QR back into its module grid", () => {
    const modules = parseQrSvg(MOCK_TOTP_QR_SVG);
    if (!modules) throw new Error("not parsed");
    // A 57-unit tile less its 4-module quiet zone on each side.
    expect(modules.size).toBe(49);
    // The top-left eye: a dark 7-module ring round a light ring and a dark 3x3 centre.
    expect(modules.dark[0]?.slice(0, 7)).toEqual(Array(7).fill(true));
    expect(modules.dark[1]?.slice(0, 7)).toEqual([true, false, false, false, false, false, true]);
    expect(modules.dark[3]?.slice(0, 7)).toEqual([true, false, true, true, true, false, true]);
  });

  it("gives up on an SVG it does not know, so the caller shows it as is", () => {
    expect(parseQrSvg('<svg viewBox="0 0 10 10"><circle r="4"/></svg>')).toBeNull();
    expect(parseQrSvg("<svg/>")).toBeNull();
  });
});
