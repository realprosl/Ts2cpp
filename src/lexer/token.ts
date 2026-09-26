import type { Span } from "../core/span.ts";

export type TokenKind =
  | "identifier" | "number" | "string" | "template" | "let" | "const" | "function" | "interface" | "class" | "new" | "return"
  | "if" | "else" | "while" | "for" | "break" | "continue" | "extends" | "export" | "true" | "false" | "mut" | "out" | "async" | "await" | "type"
  | "enum" | "switch" | "case" | "default" | "of" | "in" | "delete" | "instanceof" | "typeof" | "readonly"
  | "(" | ")" | "{" | "}" | "[" | "]" | "," | ";" | ":" | "." | "..." | "?"
  | "+" | "-" | "*" | "/" | "%" | "=" | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "??" | "|" | "&" | "^" | "~" | "<<" | ">>" | "=>" | "!" | "eof";

export interface Token { kind: TokenKind; lexeme: string; span: Span }

export const KEYWORDS: Readonly<Record<string, TokenKind>> = Object.assign(Object.create(null), {
  let: "let", const: "const", function: "function", interface: "interface", class: "class", new: "new", return: "return", if: "if", else: "else",
  while: "while", for: "for", break: "break", continue: "continue", extends: "extends", export: "export", true: "true", false: "false", mut: "mut", out: "out", async: "async", await: "await", number: "type", string: "type", boolean: "type", void: "type", type: "type",
  enum: "enum", switch: "switch", case: "case", default: "default", of: "of", in: "in", delete: "delete", instanceof: "instanceof", typeof: "typeof", readonly: "readonly"
});
