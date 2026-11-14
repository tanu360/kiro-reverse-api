import type { HighlighterCore, LanguageInput, ThemedToken, ThemeRegistration } from "shiki/core";

/** The languages a CodeBlock can highlight (the API page's client snippets, prometheus.yml). */
export type CodeLanguage =
  | "bash"
  | "toml"
  | "python"
  | "typescript"
  | "javascript"
  | "json"
  | "go"
  | "java"
  | "php"
  | "ruby"
  | "csharp"
  | "yaml";

/* Each grammar is its own chunk, fetched the first time a block needs it (PHP's pulls in HTML). */
const GRAMMARS: Record<CodeLanguage, LanguageInput> = {
  bash: () => import("shiki/langs/bash.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
};

const THEME = "kiro";

const color = (token: string) => `var(--code-token-${token})`;

/*
 * The app's code theme: TextMate scopes mapped onto the --code-token-* colours in index.css, so
 * the code follows light and dark like the rest of the UI and every colour stays a theme token.
 * Later rules win over earlier ones for the same scope depth, so the specific ones come last.
 */
const KIRO_THEME: ThemeRegistration = {
  name: THEME,
  type: "dark",
  colors: {
    "editor.foreground": "var(--code-block-foreground)",
    "editor.background": "transparent",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: color("comment"), fontStyle: "italic" },
    },
    {
      scope: ["punctuation", "meta.brace", "keyword.operator", "constant.character.escape"],
      settings: { foreground: color("punctuation") },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "entity.name.section",
        "keyword.operator.new",
      ],
      settings: { foreground: color("keyword") },
    },
    {
      scope: ["string", "punctuation.definition.string"],
      settings: { foreground: color("string") },
    },
    {
      scope: ["constant.numeric", "constant.language", "support.constant"],
      settings: { foreground: color("constant") },
    },
    // Shell variables ($KIRO_API_KEY, an exported name), even inside a quoted string.
    {
      scope: [
        "variable.other.normal",
        "punctuation.definition.variable",
        "variable.other.assignment",
        "variable.other.constant.property",
      ],
      settings: { foreground: color("constant") },
    },
    // Commands and functions: curl, claude, print, OpenAI(…), create(…).
    {
      scope: [
        "entity.name.command",
        "entity.name.function",
        "support.function",
        "meta.function-call.generic",
        "entity.name.type",
        "support.class",
      ],
      settings: { foreground: color("function") },
    },
    // Command-line flags (-H, -d).
    { scope: ["constant.other.option"], settings: { foreground: color("parameter") } },
    // Keys: TOML and YAML keys, object keys, keyword arguments.
    {
      scope: [
        "entity.name.tag.yaml",
        "variable.other.key",
        "meta.object-literal.key",
        "support.type.property-name",
        "variable.parameter",
      ],
      settings: { foreground: color("property") },
    },
  ],
};

let highlighterPromise: Promise<HighlighterCore> | null = null;

/**
 * One Shiki highlighter for the app, built on first use and loaded in its own chunk: the core and
 * the JavaScript regex engine (no WebAssembly). Grammars are added as blocks ask for them.
 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [KIRO_THEME],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  // A failed load (offline, a stale chunk after an update) is retried on the next block.
  highlighterPromise.catch(() => {
    highlighterPromise = null;
  });
  return highlighterPromise;
}

const grammarLoads = new Map<CodeLanguage, Promise<void>>();

/** Loads a grammar into the highlighter once; a failed load is retried on the next block. */
function loadGrammar(highlighter: HighlighterCore, grammar: CodeLanguage): Promise<void> {
  let load = grammarLoads.get(grammar);
  if (!load) {
    load = highlighter.loadLanguage(GRAMMARS[grammar]);
    load.catch(() => grammarLoads.delete(grammar));
    grammarLoads.set(grammar, load);
  }
  return load;
}

type Highlight = (code: string, lang: CodeLanguage) => ThemedToken[][];

/**
 * A JSON body in a shell command (curl's `-d '{…}'`) is one single-quoted string to the bash
 * grammar, so it would come out as a block of string colour. Each such body that parses as JSON
 * is highlighted as JSON and spliced back over the string's tokens; the quotes stay as they were.
 */
function embedJson(code: string, lines: ThemedToken[][], highlight: Highlight): ThemedToken[][] {
  const ranges: { start: number; end: number; tokens: ThemedToken[][] }[] = [];
  for (const match of code.matchAll(/'(\{[\s\S]*?\})'/g)) {
    const body = match[1];
    try {
      JSON.parse(body);
    } catch {
      continue;
    }
    const start = (match.index ?? 0) + 1;
    ranges.push({ start, end: start + body.length, tokens: highlight(body, "json") });
  }
  if (ranges.length === 0) return lines;

  // Every token as an absolute span; shell tokens inside a body are cut away.
  const flat: ThemedToken[] = [];
  const inBody = (offset: number) =>
    ranges.some(({ start, end }) => offset >= start && offset < end);
  for (const line of lines) {
    for (const token of line) {
      let piece = "";
      let pieceStart = token.offset;
      for (let index = 0; index < token.content.length; index += 1) {
        const offset = token.offset + index;
        if (inBody(offset)) {
          if (piece) flat.push({ ...token, content: piece, offset: pieceStart });
          piece = "";
          pieceStart = offset + 1;
        } else {
          piece += token.content[index];
        }
      }
      if (piece) flat.push({ ...token, content: piece, offset: pieceStart });
    }
  }
  for (const { start, tokens } of ranges) {
    for (const line of tokens) {
      for (const token of line) flat.push({ ...token, offset: token.offset + start });
    }
  }
  flat.sort((a, b) => a.offset - b.offset);

  // Back into lines: a token's line is the number of line breaks before it.
  const out: ThemedToken[][] = code.split("\n").map(() => []);
  let line = 0;
  let lineEnd = code.indexOf("\n");
  for (const token of flat) {
    while (lineEnd !== -1 && token.offset > lineEnd) {
      line += 1;
      lineEnd = code.indexOf("\n", lineEnd + 1);
    }
    out[line].push(token);
  }
  return out;
}

/** The code as lines of coloured tokens; each token's `color` is a CSS variable reference. */
export async function highlightCode(code: string, lang: CodeLanguage): Promise<ThemedToken[][]> {
  const highlighter = await getHighlighter();
  // bash embeds JSON bodies, so it needs the JSON grammar too.
  const grammars: CodeLanguage[] = lang === "bash" ? ["bash", "json"] : [lang];
  await Promise.all(grammars.map((grammar) => loadGrammar(highlighter, grammar)));
  const highlight: Highlight = (text, language) =>
    highlighter.codeToTokens(text, { lang: language, theme: THEME }).tokens;
  const lines = highlight(code, lang);
  return lang === "bash" ? embedJson(code, lines, highlight) : lines;
}
