import { describe, expect, it } from "vitest";
import type { ResponseHeaderRule } from "@/lib/api/response-headers";
import {
  headerNameProblem,
  headerProblem,
  headerValueProblem,
  insertVariable,
  isResponseHeaderErrorCode,
  listProblem,
  normalizeHeaders,
  problemMessage,
  sameResponseHeaders,
  unknownVariable,
} from "./response-headers";

const rule = (name: string, value = "{request_id}", enabled = true): ResponseHeaderRule => ({
  name,
  value,
  enabled,
});

describe("headerNameProblem", () => {
  it("takes RFC 7230 tokens", () => {
    for (const name of ["X-Request-Id", "x_trace", "A1", "!#$%&'*+-.^_`|~"]) {
      expect(headerNameProblem(name)).toBeNull();
    }
  });

  it("refuses empty, spaced, colon, non-ASCII and over-long names", () => {
    expect(headerNameProblem("  ")?.code).toBe("response_header_name_empty");
    expect(headerNameProblem("Bad Name")?.code).toBe("response_header_name_invalid");
    expect(headerNameProblem("X-Id:")?.code).toBe("response_header_name_invalid");
    expect(headerNameProblem("X-Ünïcode")?.code).toBe("response_header_name_invalid");
    expect(headerNameProblem("x".repeat(129))?.code).toBe("response_header_name_too_long");
    // Go counts bytes: 65 two-byte letters are 130 bytes.
    expect(headerNameProblem("é".repeat(65))?.code).toBe("response_header_name_too_long");
    expect(headerNameProblem("x".repeat(128))).toBeNull();
  });

  it("refuses hop-by-hop, framing, Date, Set-Cookie and CORS headers in any case", () => {
    for (const name of [
      "Connection",
      "keep-alive",
      "TRANSFER-ENCODING",
      "Content-Length",
      "content-type",
      "Upgrade",
      "Date",
      "Set-Cookie",
      "Access-Control-Allow-Origin",
      "access-control-expose-headers",
    ]) {
      expect(headerNameProblem(name), name).toEqual({
        code: "response_header_name_forbidden",
        params: { name },
      });
    }
  });
});

describe("headerValueProblem", () => {
  it("takes text and variables, trimmed of spaces and tabs", () => {
    expect(headerValueProblem("  {request_id}\t")).toBeNull();
    expect(headerValueProblem("kiro/{model}@{account_id}")).toBeNull();
    expect(headerValueProblem("a\tb")).toBeNull();
  });

  it("refuses empty values, line breaks and control characters", () => {
    expect(headerValueProblem(" \t", "X-A")).toEqual({
      code: "response_header_value_empty",
      params: { name: "X-A" },
    });
    for (const value of ["a\r\nX-Evil: 1", "a\nb", "a\rb", "a\u0000b", "a\u007fb"]) {
      expect(headerValueProblem(value)?.code, JSON.stringify(value)).toBe(
        "response_header_value_invalid",
      );
    }
  });

  it("counts the length in UTF-8 bytes", () => {
    expect(headerValueProblem("x".repeat(512))).toBeNull();
    expect(headerValueProblem("x".repeat(513))?.code).toBe("response_header_value_too_long");
    // 171 three-byte characters are 513 bytes.
    expect(headerValueProblem("中".repeat(171))?.code).toBe("response_header_value_too_long");
  });

  it("refuses an unknown {name} placeholder and leaves other braces alone", () => {
    expect(headerValueProblem("{reqid}")).toEqual({
      code: "response_header_unknown_variable",
      params: { variable: "reqid" },
    });
    expect(unknownVariable("{request_id}-{modle}")).toBe("modle");
    expect(unknownVariable("{} {1x} {a-b} {open")).toBeNull();
  });

  it("refuses a variable typed in another case", () => {
    expect(unknownVariable("{Request_Id}")).toBe("Request_Id");
    expect(unknownVariable("{request_id} {MODEL}")).toBe("MODEL");
  });
});

describe("headerProblem and listProblem", () => {
  it("refuses a name already in the list, ignoring case", () => {
    expect(headerProblem(rule("x-request-id"), [rule("X-Request-Id")])).toEqual({
      code: "response_header_name_duplicate",
      params: { name: "x-request-id" },
    });
    expect(headerProblem(rule("X-Other"), [rule("X-Request-Id")])).toBeNull();
  });

  it("finds the first problem with its index, as the server does", () => {
    expect(listProblem([rule("X-A"), rule("X-B")])).toBeNull();
    expect(listProblem([rule("X-A"), rule("Content-Type")])).toMatchObject({
      index: 1,
      code: "response_header_name_forbidden",
    });
    expect(listProblem([rule("X-A"), rule("x-a")])).toMatchObject({
      index: 1,
      code: "response_header_name_duplicate",
    });
    const tooMany = Array.from({ length: 21 }, (_, i) => rule(`X-H${i}`));
    expect(listProblem(tooMany)).toEqual({
      index: -1,
      code: "response_headers_too_many",
      params: { max: 20 },
    });
    expect(listProblem(tooMany.slice(0, 20))).toBeNull();
  });

  it("knows the server's codes", () => {
    expect(isResponseHeaderErrorCode("response_header_name_forbidden")).toBe(true);
    expect(isResponseHeaderErrorCode("invalid_json")).toBe(false);
    expect(isResponseHeaderErrorCode(undefined)).toBe(false);
  });
});

describe("problemMessage", () => {
  it("passes the params and shows a variable in braces", () => {
    const calls: Array<[string, unknown]> = [];
    const t = (key: string, params?: unknown) => {
      calls.push([key, params]);
      return key;
    };
    problemMessage({ code: "response_header_unknown_variable", params: { variable: "x" } }, t);
    problemMessage({ code: "response_headers_too_many", params: { max: 20 } }, t);
    expect(calls).toEqual([
      ["settings:responseHeaders.error.unknownVariable", { variable: "{x}" }],
      ["settings:responseHeaders.limit", { max: 20 }],
    ]);
  });
});

describe("insertVariable", () => {
  it("puts the variable at the caret, or in place of the selection", () => {
    expect(insertVariable("req-", 4, 4, "request_id")).toEqual({
      value: "req-{request_id}",
      caret: 16,
    });
    expect(insertVariable("a-XX-b", 2, 4, "model")).toEqual({ value: "a-{model}-b", caret: 9 });
    expect(insertVariable("", null, null, "key_id")).toEqual({ value: "{key_id}", caret: 8 });
  });

  it("clamps a selection past the end to the end", () => {
    expect(insertVariable("ab", 9, 12, "client_ip")).toEqual({
      value: "ab{client_ip}",
      caret: 13,
    });
  });
});

describe("normalizeHeaders and sameResponseHeaders", () => {
  it("trims names and values and compares lists by content", () => {
    const raw = [rule(" X-A\t", "\t{model} ", false)];
    expect(normalizeHeaders(raw)).toEqual([rule("X-A", "{model}", false)]);
    expect(sameResponseHeaders([rule("X-A")], [rule("X-A")])).toBe(true);
    expect(sameResponseHeaders([rule("X-A")], [rule("X-A", "{request_id}", false)])).toBe(false);
    expect(sameResponseHeaders([rule("X-A"), rule("X-B")], [rule("X-B"), rule("X-A")])).toBe(false);
  });
});
