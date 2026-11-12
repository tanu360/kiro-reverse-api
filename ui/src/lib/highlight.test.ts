import { describe, expect, it } from "vitest";
import { highlightCode } from "./highlight";

const CURL = `curl "http://localhost/v1/messages" \\
  -H "x-api-key: $KIRO_API_KEY" \\
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 1024
  }'`;

describe("highlightCode", () => {
  it("keeps every character, line for line", async () => {
    const lines = await highlightCode(CURL, "bash");
    expect(lines.map((line) => line.map((token) => token.content).join(""))).toEqual(
      CURL.split("\n"),
    );
  });

  it("colours a curl JSON body as JSON, not as one shell string", async () => {
    const lines = await highlightCode(CURL, "bash");
    const color = (text: string) =>
      lines.flat().find((token) => token.content.includes(text))?.color;
    expect(color("curl")).toBe("var(--code-token-function)");
    expect(color("-")).toBe("var(--code-token-parameter)");
    expect(color("KIRO_API_KEY")).toBe("var(--code-token-constant)");
    expect(color("model")).toBe("var(--code-token-property)");
    expect(color("1024")).toBe("var(--code-token-constant)");
    expect(color("claude-sonnet-5")).toBe("var(--code-token-string)");
  });

  it("loads a grammar on first use and keeps every character", async () => {
    const go =
      'package main\n\nfunc main() {\n\treq.Header.Set("x-api-key", os.Getenv("KIRO_API_KEY"))\n}';
    const lines = await highlightCode(go, "go");
    expect(lines.map((line) => line.map((token) => token.content).join(""))).toEqual(
      go.split("\n"),
    );
    expect(lines[0].find((token) => token.content === "package")?.color).toBe(
      "var(--code-token-keyword)",
    );
  });
});
