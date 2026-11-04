import { describe, expect, it } from "vitest";
import { compilesInGo } from "./go-regex";

// Every expectation below was checked against Go's regexp.Compile.
describe("compilesInGo", () => {
  it("accepts inline flags, alone, combined, negated or scoped to a group", () => {
    for (const pattern of [
      "(?i)secret",
      "(?s).*",
      "(?m)^x$",
      "(?U)a+",
      "(?is)a.b",
      "(?i-s)a.b",
      "(?-m)^x",
      "(?i:abc)d",
      "a(?i)b",
      "(?ii)a",
      "(?)a",
      "(?:a|b)",
    ]) {
      expect(compilesInGo(pattern), pattern).toBe(true);
    }
  });

  it("rejects malformed flag groups", () => {
    for (const pattern of ["(?i", "(?-)", "(?i-)", "(?--i)", "(?z)", "(?#comment)", "(?'n'a)"]) {
      expect(compilesInGo(pattern), pattern).toBe(false);
    }
  });

  it("rejects lookarounds and atomic groups", () => {
    for (const pattern of ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "(?>a)"]) {
      expect(compilesInGo(pattern), pattern).toBe(false);
    }
  });

  it("rejects backreferences but reads \\0 and \\1 plus an octal digit as octal", () => {
    for (const pattern of ["(a)\\1", "(a)(b)\\2", "\\8", "\\9", "(?<n>a)\\k<n>", "[\\1]"]) {
      expect(compilesInGo(pattern), pattern).toBe(false);
    }
    for (const pattern of ["\\0", "\\012", "\\12", "\\101"]) {
      expect(compilesInGo(pattern), pattern).toBe(true);
    }
  });

  it("accepts Go's named groups, even duplicate names, and checks the name", () => {
    expect(compilesInGo("(?P<year>\\d{4})")).toBe(true);
    expect(compilesInGo("(?<year>\\d{4})")).toBe(true);
    expect(compilesInGo("(?<1st>a)")).toBe(true);
    expect(compilesInGo("(?<n>a)(?<n>b)")).toBe(true);
    expect(compilesInGo("(?<>a)")).toBe(false);
    expect(compilesInGo("(?<a-b>a)")).toBe(false);
    expect(compilesInGo("(?P=n)")).toBe(false);
  });

  it("follows Go's escapes", () => {
    for (const pattern of [
      "\\Aa\\z",
      "\\bword\\B",
      "\\d\\D\\s\\S\\w\\W",
      "\\a\\f\\n\\r\\t\\v",
      "\\x41\\x{1F600}",
      "\\Qa.b(c\\E",
      "\\Qunclosed(",
      "\\pL\\p{Greek}\\p{^Han}\\PN\\p{Lu}\\p{Letter}\\p{Any}",
      "\\p{greek}\\p{Old_Italic}\\p{old italic}",
      "\\.\\-\\_\\]",
    ]) {
      expect(compilesInGo(pattern), pattern).toBe(true);
    }
    for (const pattern of [
      "a\\",
      "\\Z",
      "\\u0041",
      "\\cA",
      "\\C",
      "\\e",
      "\\é",
      "\\x4",
      "\\x{}",
      "\\x{110000}",
      "\\pX",
      "\\p{Klingon}",
      "\\p{Lu",
      "\\p",
    ]) {
      expect(compilesInGo(pattern), pattern).toBe(false);
    }
  });

  it("follows Go's character classes", () => {
    for (const pattern of [
      "[a-z]",
      "[^a-z]",
      "[]a]",
      "[^]a]",
      "[a-]",
      "[\\d-z]",
      "[[:alpha:]_]",
      "[[:^digit:]]",
      "[\\pL\\p{Greek}]",
      "[\\x{41}-\\x{5A}]",
      "[[]",
    ]) {
      expect(compilesInGo(pattern), pattern).toBe(true);
    }
    for (const pattern of ["[a", "[]", "[^]", "[z-a]", "[a-\\d]", "[\\b]", "[[:foo:]]", "[\\Q]"]) {
      expect(compilesInGo(pattern), pattern).toBe(false);
    }
  });

  it("follows Go's repetition rules", () => {
    for (const pattern of [
      "a{2}",
      "a{2,}",
      "a{2,5}?",
      "a{1000}",
      "a{,5}",
      "a{01}",
      "x{",
      "^*",
      "\\b+",
      "(a{2}){500}",
      "((a{600}){0}){2}",
      "a*(?i)*",
    ]) {
      expect(compilesInGo(pattern), pattern).toBe(true);
    }
    for (const pattern of [
      "*a",
      "a|*",
      "(*)",
      "a**",
      "a*+",
      "a{2}{3}",
      "a{2}*",
      "a{1001}",
      "a{3,2}",
      "(a{100}){11}",
      "(?i)*",
    ]) {
      expect(compilesInGo(pattern), pattern).toBe(false);
    }
  });

  it("needs balanced parentheses", () => {
    expect(compilesInGo("(a(b)c)")).toBe(true);
    expect(compilesInGo("(")).toBe(false);
    expect(compilesInGo("a)")).toBe(false);
    expect(compilesInGo("(a))(")).toBe(false);
  });

  it("accepts the empty pattern and plain text with emoji", () => {
    expect(compilesInGo("")).toBe(true);
    expect(compilesInGo("héllo 😀+")).toBe(true);
  });
});
