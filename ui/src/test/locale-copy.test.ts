import { describe, expect, it } from "vitest";
import { catalog, namespaces } from "./locale-catalog";

// Rules from the copy style guide that a machine can check. English is the source language;
// Chinese follows the glossary and spacing rules. vi and pt-BR have their own reviewers.

const HAN = /\p{Script=Han}/u;

function entries(lang: string): [string, string][] {
  return namespaces.flatMap((ns) =>
    Object.entries(catalog[ns][lang] ?? {}).map(([key, text]): [string, string] => [
      `${ns}:${key}`,
      text,
    ]),
  );
}

/** Places where a Hanzi touches an ASCII letter, digit or {placeholder} with no space between. */
function missingSpaces(text: string): string[] {
  const chars = [...text];
  const found: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const [a, b] = [chars[i], chars[i + 1]];
    if ((HAN.test(a) && /[A-Za-z0-9{]/.test(b)) || (/[A-Za-z0-9}]/.test(a) && HAN.test(b))) {
      found.push(`${a}${b}`);
    }
  }
  return found;
}

describe("English copy", () => {
  const en = entries("en");

  it("uses the ellipsis character, not three dots", () => {
    expect(en.filter(([, text]) => text.includes("...")).map(([key]) => key)).toEqual([]);
  });

  it("does not say Please or Oops, and has no exclamation marks", () => {
    expect(
      en.filter(([, text]) => /\b(Please|please|Oops)\b|!/.test(text)).map(([key]) => key),
    ).toEqual([]);
  });

  it("has no leading +, * or ! markers", () => {
    expect(en.filter(([, text]) => /^\s*[+*!]/.test(text)).map(([key]) => key)).toEqual([]);
  });

  it("writes sign in and sign out, not login or logout as verbs", () => {
    expect(
      en.filter(([, text]) => /\b(Log ?in|Log ?out|Logout)\b/.test(text)).map(([key]) => key),
    ).toEqual([]);
  });

  it("uses one ASCII-safe spelling for canceled", () => {
    expect(en.filter(([, text]) => /cancelled/i.test(text)).map(([key]) => key)).toEqual([]);
  });
});

describe("Chinese copy", () => {
  const zh = entries("zh");

  it("uses 账号 and 添加, never 账户 or 新增", () => {
    expect(zh.filter(([, text]) => /账户|新增/.test(text)).map(([key]) => key)).toEqual([]);
  });

  it("puts a space between Hanzi and Latin letters, digits or placeholders", () => {
    const bad = zh
      .map(([key, text]) => [key, missingSpaces(text)] as const)
      .filter(([, found]) => found.length > 0)
      .map(([key, found]) => `${key}: ${found.join(" ")}`);
    expect(bad).toEqual([]);
  });

  it("uses full-width parentheses next to Hanzi", () => {
    const bad = zh
      .filter(([, text]) => /\p{Script=Han}\s*\(|\)\s*\p{Script=Han}/u.test(text))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("uses full-width ，。；：？！ next to Hanzi and the ellipsis character", () => {
    const bad = zh
      .filter(([, text]) => /\p{Script=Han}[,.;:?!]|[,;:?!]\p{Script=Han}|\.\.\./u.test(text))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("writes Token and 禁用, never 令牌, lowercase token or 停用", () => {
    const bad = zh
      .filter(([, text]) => /令牌|停用|(?<![\w-])token(?![\w.-])/.test(text))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("keeps the glossary terms: API Key, Kiro Profile, 刷新 Token, 管理员密码", () => {
    const bad = zh
      .filter(([, text]) =>
        /API ?key|Api Key|(?<![A-Za-z])(?<!API )Key(?![a-z])|管理密码|刷新令牌|(?<!Kiro )Profile/.test(
          text,
        ),
      )
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });

  it("writes in-progress text as 正在…", () => {
    expect(
      zh.filter(([, text]) => /中…$/.test(text) && !/^正在/.test(text)).map(([key]) => key),
    ).toEqual([]);
  });
});

describe("Vietnamese copy", () => {
  const vi = entries("vi");

  it("uses the ellipsis character, not three dots", () => {
    expect(vi.filter(([, text]) => text.includes("...")).map(([key]) => key)).toEqual([]);
  });

  it("writes xóa, hủy, khóa, tùy with the modern tone mark, and model, not mô hình", () => {
    const bad = vi
      .filter(([, text]) => /(?:xoá|huỷ|khoá|tuỳ|hoá)(?!\p{L})|mô hình/iu.test(text))
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });
});

describe("Portuguese copy", () => {
  const pt = entries("pt-BR");

  it("uses the ellipsis character, not three dots", () => {
    expect(pt.filter(([, text]) => text.includes("...")).map(([key]) => key)).toEqual([]);
  });

  it("keeps the glossary terms: requisição, habilitar/desabilitar, perfil do Kiro", () => {
    const bad = pt
      .filter(([, text]) =>
        /solicitaç|\b(?:des)?ativ(?:ar|ad[ao]s?)\b|\bperf(?:il|is) Kiro\b/i.test(text),
      )
      .map(([key]) => key);
    expect(bad).toEqual([]);
  });
});
