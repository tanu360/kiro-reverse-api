import { parse } from "@babel/parser";

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
export const ALLOWED_TOKENS: readonly string[] = [
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

const tokenPattern = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...ALLOWED_TOKENS]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "gu",
);

/** True when the text has letters left after the allowed tokens are removed. */
export function hasProse(text: string): boolean {
  return /\p{L}/u.test(text.replace(tokenPattern, ""));
}

function isKeyLike(text: string): boolean {
  return KEY_LIKE.test(text.trim());
}

function isVisibleName(name: string): boolean {
  if (DATA_NAMES.has(name)) return false;
  return VISIBLE_ATTRS.has(name) || VISIBLE_SUFFIX.test(name);
}

// biome-ignore lint/suspicious/noExplicitAny: Babel AST nodes are walked generically.
type Node = any;

/** String literals an expression can evaluate to directly (not through calls). */
function literalTexts(node: Node): Node[] {
  if (!node) return [];
  switch (node.type) {
    case "StringLiteral":
      return [node];
    case "TemplateLiteral":
      return node.quasis.map((quasi: Node) => ({
        ...quasi,
        value: quasi.value.cooked ?? quasi.value.raw,
      }));
    case "ConditionalExpression":
      return [...literalTexts(node.consequent), ...literalTexts(node.alternate)];
    case "LogicalExpression":
      return [...literalTexts(node.left), ...literalTexts(node.right)];
    case "BinaryExpression":
      return node.operator === "+" ? [...literalTexts(node.left), ...literalTexts(node.right)] : [];
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return literalTexts(node.expression);
    default:
      return [];
  }
}

/** Template literals an expression can evaluate to directly. */
function templates(node: Node): Node[] {
  if (!node) return [];
  switch (node.type) {
    case "TemplateLiteral":
      return [node];
    case "ConditionalExpression":
      return [...templates(node.consequent), ...templates(node.alternate)];
    case "LogicalExpression":
      return [...templates(node.left), ...templates(node.right)];
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return templates(node.expression);
    default:
      return [];
  }
}

// Sentence punctuation between interpolations: a sentence built from parts.
const COMPOSED_GLUE = /[:.,;!?。，：；！？]/;

function jsxName(node: Node): string {
  if (!node) return "";
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression") return `${jsxName(node.object)}.${node.property.name}`;
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  return "";
}

function propName(node: Node): string | undefined {
  if (node.computed) return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "StringLiteral") return node.key.value;
  return undefined;
}

function calleeName(node: Node): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    return `${calleeName(node.object)}.${node.property.name}`;
  }
  return "";
}

export function scanSource(code: string, file: string): Finding[] {
  const ast = parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
    errorRecovery: false,
  });
  const findings: Finding[] = [];

  const report = (kind: string, node: Node, text: string, strict: boolean) => {
    const value = text.replace(/\s+/g, " ").trim();
    if (!value || !hasProse(value) || NOT_PROSE.test(value)) return;
    if (!strict && isKeyLike(value)) return;
    findings.push({ file, line: node.loc?.start.line ?? 0, kind, text: value });
  };

  const reportExpression = (kind: string, expression: Node, strict: boolean) => {
    for (const literal of literalTexts(expression)) report(kind, literal, literal.value, strict);
    // `${t("a")}: ${value}.` glues translated parts with punctuation that differs by language
    // ("：" and "。" in Chinese). The whole sentence must be one key with placeholders.
    for (const template of templates(expression)) {
      const glue = template.quasis.map((quasi: Node) => quasi.value.cooked ?? "").join("{…}");
      if (template.expressions.length > 0 && COMPOSED_GLUE.test(glue.replace(/\{…\}/g, ""))) {
        findings.push({
          file,
          line: template.loc?.start.line ?? 0,
          kind: `${kind} composed`,
          text: glue.replace(/\s+/g, " ").trim(),
        });
      }
    }
  };

  const walk = (node: Node, inCode: boolean, inTypes: boolean, parent = ""): void => {
    if (!node || typeof node.type !== "string") return;
    let code = inCode;
    let types = inTypes;

    switch (node.type) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
        return;
      case "TSTypeAnnotation":
      case "TSTypeAliasDeclaration":
      case "TSInterfaceDeclaration":
      case "TSTypeParameterInstantiation":
      case "TSLiteralType":
        types = true;
        break;
      case "JSXElement": {
        const name = jsxName(node.openingElement.name);
        if (CODE_ELEMENTS.has(name)) code = true;
        break;
      }
      case "JSXText":
        if (!code) report("jsx-text", node, node.value, true);
        break;
      case "JSXAttribute": {
        const name = jsxName(node.name);
        if (!code && isVisibleName(name) && node.value) {
          if (node.value.type === "StringLiteral")
            report(`prop ${name}`, node.value, node.value.value, false);
          else if (node.value.type === "JSXExpressionContainer") {
            reportExpression(`prop ${name}`, node.value.expression, false);
          }
        }
        break;
      }
      case "JSXExpressionContainer":
        // A string child: {"text"} or {cond ? "a" : "b"}.
        if (!code && !types && parent !== "JSXAttribute") {
          reportExpression("jsx-child", node.expression, true);
        }
        break;
      case "ObjectProperty": {
        const name = propName(node);
        if (!types && name && isVisibleName(name))
          reportExpression(`property ${name}`, node.value, false);
        break;
      }
      case "AssignmentExpression": {
        const target = calleeName(node.left);
        if (target === "document.title") reportExpression("document.title", node.right, true);
        break;
      }
      case "CallExpression": {
        const callee = calleeName(node.callee);
        const [object, method] = callee.split(".");
        const isToast =
          (object === "toast" && TOAST_METHODS.has(method ?? "")) || callee === "toast";
        const isDialog = ["alert", "confirm", "prompt", "window.alert", "window.confirm"].includes(
          callee,
        );
        if (isToast || isDialog) reportExpression(callee, node.arguments[0], true);
        break;
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
      if (key === "leadingComments" || key === "trailingComments" || key === "innerComments")
        continue;
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) walk(item, code, types, node.type);
      else if (child && typeof child === "object" && typeof child.type === "string") {
        walk(child, code, types, node.type);
      }
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
