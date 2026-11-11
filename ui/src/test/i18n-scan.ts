import { parse } from "@babel/parser";
import { type AstNode, fields, isAstNode, isNode, type NodeOf } from "./babel-ast";

/**
 * Static scan for user-visible text that bypasses the locale files. It parses a source file and
 * reports JSX text, user-visible string props, string children, toast/confirm arguments,
 * document.title assignments and user-visible object properties that hold literal text.
 *
 * A literal is allowed when nothing but product tokens (ALLOWED_TOKENS), digits and punctuation
 * is left, or when it looks like a translation key. Anything else must come from `t()` or be
 * listed in hardcoded-text-allowlist.json with a reason.
 */

export interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/** Brand, product and protocol names that stay as written in every language. */
const ALLOWED_TOKENS: readonly string[] = [
  "Kiro Proxy",
  "AWS Builder ID",
  "IAM Identity Center",
  "Microsoft Entra ID",
  "Claude Code",
  "Kiro",
  "Codex",
  "OpenAI",
  "Anthropic",
  "JSON",
  "URL",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  // Keyboard key names.
  "Ctrl",
  "Shift",
  "Alt",
  "Enter",
  "Esc",
  "Tab",
];

// Props whose string value is read or shown to the user.
const VISIBLE_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "placeholder",
  "alt",
  "label",
  "description",
  "tooltip",
  "hint",
  "heading",
  "caption",
  "subtitle",
  "message",
  "text",
]);
const VISIBLE_SUFFIX =
  /(Label|Text|Title|Message|Description|Placeholder|Hint|Tooltip|Caption|Heading)$/;

// Elements whose text content is code, keys or data rather than prose.
const CODE_ELEMENTS = new Set(["code", "pre", "kbd", "samp", "Code", "Kbd", "KbdGroup"]);

const TOAST_METHODS = new Set(["success", "error", "warning", "info", "loading"]);

// "ns:key", "group.key" or a camelCase key name such as "microsoftChoiceHint".
const KEY_LIKE = /^(?:[A-Za-z][\w-]*(?::[\w.-]+|(?:\.[\w-]+)+)|[a-z]+[A-Z][A-Za-z0-9]*)$/;

// CSS values and colours, not prose.
const NOT_PROSE = /^(?:var\(|url\(|#[\da-f]{3,8}$)/i;

// Names that end like a visible prop but hold data (raw server text matched against a table).
const DATA_NAMES = new Set(["serverMessage"]);

// Tailwind utilities that are a bare word, with no dash, colon or bracket.
const BARE_UTILITIES = new Set([
  "flex",
  "grid",
  "block",
  "inline",
  "hidden",
  "contents",
  "truncate",
  "relative",
  "absolute",
  "fixed",
  "sticky",
  "static",
  "isolate",
  "invisible",
  "visible",
  "underline",
  "italic",
  "uppercase",
  "lowercase",
  "capitalize",
  "border",
  "rounded",
  "shadow",
  "outline",
  "ring",
  "transition",
  "grow",
  "shrink",
  "group",
  "peer",
  "container",
  "table",
  "antialiased",
]);
const UTILITY_WORD = /^!?-?[a-z@*&[(.][\w@*&[\]():/.%#=>,'"!-]*$/;
const UTILITY_MARK = /[-:[\]/]/;

/**
 * A class list such as "flex h-5 items-center": every word is a utility (it has a dash, colon,
 * bracket or slash, or is a bare utility such as `flex`) and at least one is marked. A map of
 * variant classes keyed `label` or `title` is styling, not text.
 */
function isClassList(text: string): boolean {
  const words = text.trim().split(/\s+/);
  if (text.includes("://")) return false;
  if (!words.every((word) => UTILITY_WORD.test(word))) return false;
  if (!words.some((word) => UTILITY_MARK.test(word))) return false;
  // One hyphenated word ("sign-in", "us-east-1") may be prose or data; a lone utility needs a
  // variant colon or an arbitrary-value bracket.
  if (words.length === 1 && !/[:[]/.test(words[0])) return false;
  return words.every((word) => UTILITY_MARK.test(word) || BARE_UTILITIES.has(word));
}

const tokenPattern = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...ALLOWED_TOKENS]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "gu",
);

/** True when the text has letters left after the allowed tokens are removed. */
function hasProse(text: string): boolean {
  return /\p{L}/u.test(text.replace(tokenPattern, ""));
}

function isKeyLike(text: string): boolean {
  return KEY_LIKE.test(text.trim());
}

function isVisibleName(name: string): boolean {
  if (DATA_NAMES.has(name)) return false;
  return VISIBLE_ATTRS.has(name) || VISIBLE_SUFFIX.test(name);
}

/** A string an expression can evaluate to, with the position to report it at. */
interface LiteralText {
  value: string;
  loc?: AstNode["loc"];
}

/** The expression inside a type assertion or parentheses (`x as T`, `x!`, `(x)`), or null. */
function unwrapped(node: AstNode | null | undefined): AstNode | null {
  if (
    isNode(node, "TSAsExpression") ||
    isNode(node, "TSSatisfiesExpression") ||
    isNode(node, "TSNonNullExpression") ||
    isNode(node, "ParenthesizedExpression")
  ) {
    return node.expression;
  }
  return null;
}

/** String literals an expression can evaluate to directly (not through calls). */
function literalTexts(node: AstNode | null | undefined): LiteralText[] {
  if (isNode(node, "StringLiteral")) return [node];
  if (isNode(node, "TemplateLiteral")) {
    return node.quasis.map((quasi) => ({
      ...quasi,
      value: quasi.value.cooked ?? quasi.value.raw,
    }));
  }
  if (isNode(node, "ConditionalExpression")) {
    return [...literalTexts(node.consequent), ...literalTexts(node.alternate)];
  }
  if (isNode(node, "LogicalExpression")) {
    return [...literalTexts(node.left), ...literalTexts(node.right)];
  }
  if (isNode(node, "BinaryExpression")) {
    return node.operator === "+" ? [...literalTexts(node.left), ...literalTexts(node.right)] : [];
  }
  const inner = unwrapped(node);
  return inner ? literalTexts(inner) : [];
}

/** Template literals an expression can evaluate to directly. */
function templates(node: AstNode | null | undefined): NodeOf<"TemplateLiteral">[] {
  if (isNode(node, "TemplateLiteral")) return [node];
  if (isNode(node, "ConditionalExpression")) {
    return [...templates(node.consequent), ...templates(node.alternate)];
  }
  if (isNode(node, "LogicalExpression")) return [...templates(node.left), ...templates(node.right)];
  const inner = unwrapped(node);
  return inner ? templates(inner) : [];
}

// Sentence punctuation between interpolations: a sentence built from parts.
const COMPOSED_GLUE = /[:.,;!?。，：；！？]/;

// Punctuation-only JSX text next to an interpolation ("{label}: <Code>…</Code>", "{a}. {b}"):
// Chinese writes "：", "。" and full-width parentheses, so the punctuation belongs in the key.
const JSX_GLUE = /[:.;!?()。：；！？（）]/;

// A `.join()` separator that ends a sentence or clause ("; ", ". "): a list of messages glued in
// English punctuation. Commas and middle dots stay allowed (CSS lists, "a · b" meta lines).
const JOIN_GLUE = /[.;:!?]\s|[。；：！？]/;

// The translation functions: t, tc, tShared, tAuth… and the tRef.current of a stable callback.
const TRANSLATE_CALLEE = /^(?:t(?:[a-z]|[A-Z]\w*)?|tRef\.current)$/;

// Type positions: a string there is a type, not text.
const TYPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeParameterInstantiation",
  "TSLiteralType",
]);

function jsxName(node: AstNode | null | undefined): string {
  if (isNode(node, "JSXIdentifier")) return node.name;
  if (isNode(node, "JSXMemberExpression")) return `${jsxName(node.object)}.${node.property.name}`;
  if (isNode(node, "JSXNamespacedName")) return `${node.namespace.name}:${node.name.name}`;
  return "";
}

function propName(node: NodeOf<"ObjectProperty">): string | undefined {
  if (node.computed) return undefined;
  if (isNode(node.key, "Identifier")) return node.key.name;
  if (isNode(node.key, "StringLiteral")) return node.key.value;
  return undefined;
}

function calleeName(node: AstNode | null | undefined): string {
  if (isNode(node, "Identifier")) return node.name;
  if (isNode(node, "MemberExpression") && !node.computed && isNode(node.property, "Identifier")) {
    return `${calleeName(node.object)}.${node.property.name}`;
  }
  return "";
}

/** True for `t("key")`, `tc("key")`, `tRef.current("key")`: a translated string. */
function isTranslateCall(node: AstNode | null | undefined): boolean {
  return isNode(node, "CallExpression") && TRANSLATE_CALLEE.test(calleeName(node.callee));
}

/** The text of a JSX child that is only punctuation glue (no letters), else null. */
function glueText(node: AstNode): string | null {
  let text: string | null = null;
  if (isNode(node, "JSXText")) text = node.value;
  else if (isNode(node, "JSXExpressionContainer") && isNode(node.expression, "StringLiteral")) {
    text = node.expression.value;
  }
  if (text === null || /\p{L}/u.test(text) || !JSX_GLUE.test(text)) return null;
  return text.replace(/\s+/g, " ").trim();
}

/** A JSX child that renders a value: an element, or an expression that is not a plain string. */
function isInterpolation(node: AstNode): boolean {
  if (isNode(node, "JSXElement") || isNode(node, "JSXFragment")) return true;
  return (
    isNode(node, "JSXExpressionContainer") &&
    node.expression.type !== "JSXEmptyExpression" &&
    !isNode(node.expression, "StringLiteral")
  );
}

export function scanSource(code: string, file: string): Finding[] {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: false,
  });
  const findings: Finding[] = [];

  const report = (kind: string, node: Pick<AstNode, "loc">, text: string, strict: boolean) => {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value || !hasProse(value) || NOT_PROSE.test(value) || isClassList(value)) return;
    if (!strict && isKeyLike(value)) return;
    findings.push({ file, line: node.loc?.start.line ?? 0, kind, text: value });
  };

  const reportComposed = (kind: string, node: Pick<AstNode, "loc">, glue: string) => {
    findings.push({
      file,
      line: node.loc?.start.line ?? 0,
      kind,
      text: glue.replace(/\s+/g, " ").trim(),
    });
  };

  // Templates already judged as a visible value, so the anywhere-rule below skips them.
  const checked = new Set<AstNode>();

  const reportExpression = (
    kind: string,
    expression: AstNode | null | undefined,
    strict: boolean,
  ) => {
    for (const literal of literalTexts(expression)) report(kind, literal, literal.value, strict);
    // `${t("a")}: ${value}.` glues translated parts with punctuation that differs by language
    // ("：" and "。" in Chinese). The whole sentence must be one key with placeholders.
    for (const template of templates(expression)) {
      checked.add(template);
      const glue = template.quasis.map((quasi) => quasi.value.cooked ?? "").join("{…}");
      if (template.expressions.length > 0 && COMPOSED_GLUE.test(glue.replace(/\{…\}/g, ""))) {
        reportComposed(`${kind} composed`, template, glue);
      }
    }
  };

  // `{label}: <Code>…</Code>` or `{a}. {b}`: punctuation glued between rendered parts.
  const reportJsxGlue = (children: readonly AstNode[]) => {
    for (const [index, child] of children.entries()) {
      const glue = glueText(child);
      if (glue === null) continue;
      const others = children.filter((_, other) => other !== index);
      if (others.some(isInterpolation)) reportComposed("jsx-text composed", child, glue);
    }
  };

  const walk = (node: unknown, inCode: boolean, inTypes: boolean, parent = ""): void => {
    if (!isAstNode(node)) return;
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return;
    let code = inCode;
    const types = inTypes || TYPE_NODES.has(node.type);

    if (isNode(node, "JSXElement")) {
      if (CODE_ELEMENTS.has(jsxName(node.openingElement.name))) code = true;
      if (!code) reportJsxGlue(node.children);
    } else if (isNode(node, "JSXFragment")) {
      if (!code) reportJsxGlue(node.children);
    } else if (isNode(node, "JSXText")) {
      if (!code) report("jsx-text", node, node.value, true);
    } else if (isNode(node, "JSXAttribute")) {
      const name = jsxName(node.name);
      if (!code && isVisibleName(name) && node.value) {
        if (isNode(node.value, "StringLiteral"))
          report(`prop ${name}`, node.value, node.value.value, false);
        else if (isNode(node.value, "JSXExpressionContainer")) {
          reportExpression(`prop ${name}`, node.value.expression, false);
        }
      }
    } else if (isNode(node, "JSXExpressionContainer")) {
      // A string child: {"text"} or {cond ? "a" : "b"}.
      if (!code && !types && parent !== "JSXAttribute") {
        reportExpression("jsx-child", node.expression, true);
      }
    } else if (isNode(node, "ObjectProperty")) {
      const name = propName(node);
      // A destructured prop's default counts too: ({ label = "Total" }) => …
      const value = isNode(node.value, "AssignmentPattern") ? node.value.right : node.value;
      if (!types && name && isVisibleName(name)) reportExpression(`property ${name}`, value, false);
    } else if (isNode(node, "AssignmentPattern")) {
      // A parameter default: (title = "Untitled") => …; destructured ones are handled above.
      if (!types && parent !== "ObjectProperty" && isNode(node.left, "Identifier")) {
        if (isVisibleName(node.left.name))
          reportExpression(`default ${node.left.name}`, node.right, false);
      }
    } else if (isNode(node, "VariableDeclarator")) {
      // const emptyMessage = "No data": a visible-named variable that holds literal text.
      if (!types && isNode(node.id, "Identifier") && isVisibleName(node.id.name)) {
        reportExpression(`variable ${node.id.name}`, node.init, false);
      }
    } else if (isNode(node, "AssignmentExpression")) {
      const target = calleeName(node.left);
      if (target === "document.title") reportExpression("document.title", node.right, true);
    } else if (isNode(node, "TemplateLiteral")) {
      // Anywhere else, a template that glues translated text to words or sentence punctuation
      // (`${t("count")} items`, `${t("a")}: ${b}`) is a sentence built from parts.
      if (!types && !checked.has(node) && node.expressions.some(isTranslateCall)) {
        const glue = node.quasis.map((quasi) => quasi.value.cooked ?? "").join("{…}");
        const rest = glue.replace(/\{…\}/g, "");
        if (COMPOSED_GLUE.test(rest) || /\p{L}/u.test(rest)) {
          reportComposed("template composed", node, glue);
        }
      }
    } else if (isNode(node, "CallExpression")) {
      const callee = calleeName(node.callee);
      const [object, method] = callee.split(".");
      const isToast = (object === "toast" && TOAST_METHODS.has(method ?? "")) || callee === "toast";
      const isDialog = ["alert", "confirm", "prompt", "window.alert", "window.confirm"].includes(
        callee,
      );
      if (isToast || isDialog) reportExpression(callee, node.arguments[0], true);
      // messages.join("; "): a list of sentences in English punctuation.
      const [separator] = node.arguments;
      if (callee.endsWith(".join") && isNode(separator, "StringLiteral")) {
        if (JOIN_GLUE.test(separator.value)) {
          reportComposed("join composed", node, `{…}${separator.value}{…}`);
        }
      }
    }

    for (const [key, child] of fields(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
      if (key === "leadingComments" || key === "trailingComments" || key === "innerComments")
        continue;
      if (Array.isArray(child)) for (const item of child) walk(item, code, types, node.type);
      else walk(child, code, types, node.type);
    }
  };

  walk(ast.program, false, false);
  return dedupe(findings);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const id = `${finding.file}:${finding.line}:${finding.kind}:${finding.text}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
