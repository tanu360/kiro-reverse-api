import type { parse } from "@babel/parser";

/*
 * Typed access to the Babel AST for the source scanners (locale usage, token lint, i18n scan).
 * @babel/types is not a direct dependency, so its node types are reached through the parser's
 * own return type. A walker sees every node as an AstNode and narrows it with `isNode` before it
 * reads a field.
 */

type Program = ReturnType<typeof parse>["program"];
type Statement = Program["body"][number];
type Expression = Extract<Statement, { type: "ExpressionStatement" }>["expression"];
type JSXElement = Extract<Expression, { type: "JSXElement" }>;
type JSXOpeningElement = JSXElement["openingElement"];
type ObjectExpression = Extract<Expression, { type: "ObjectExpression" }>;
type TemplateLiteral = Extract<Expression, { type: "TemplateLiteral" }>;
type VariableDeclaration = Extract<Statement, { type: "VariableDeclaration" }>;
type FunctionParam = Extract<Expression, { type: "ArrowFunctionExpression" }>["params"][number];

/** The Babel node types the scanners read fields from. */
type BabelNode =
  | Statement
  | Expression
  | JSXElement["children"][number]
  | JSXOpeningElement
  | JSXOpeningElement["name"]
  | JSXOpeningElement["attributes"][number]
  | ObjectExpression["properties"][number]
  | TemplateLiteral["quasis"][number]
  | VariableDeclaration["declarations"][number]
  | FunctionParam;

export type NodeOf<T extends BabelNode["type"]> = Extract<BabelNode, { type: T }>;

/** Any node of the tree: its type and source position, the fields every Babel node has. */
export type AstNode = { type: string; loc?: Program["loc"] };

export function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
  );
}

/** Narrows a node to the Babel type its `type` names. */
export function isNode<T extends BabelNode["type"]>(
  node: AstNode | null | undefined,
  type: T,
): node is NodeOf<T> {
  return node?.type === type;
}

/** The node's fields, as values to walk into. */
export function fields(node: AstNode): [string, unknown][] {
  return Object.entries<unknown>(node);
}
