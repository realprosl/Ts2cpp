import type { Span } from "../core/span.ts";

export type TokenKind =
  | "identifier" | "number" | "string" | "template" | "let" | "const" | "function" | "interface" | "class" | "new" | "return"
  | "if" | "else" | "while" | "for" | "break" | "continue" | "extends" | "export" | "true" | "false" | "out" | "async" | "await" | "using" | "type"
  | "enum" | "switch" | "case" | "default" | "of" | "in" | "delete" | "instanceof" | "typeof" | "readonly" | "match" | "when" | "union"
  | "(" | ")" | "{" | "}" | "[" | "]" | "," | ";" | ":" | "." | "..." | "?" | "@"
  | "+" | "-" | "*" | "/" | "%" | "=" | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "??" | "?." | "|" | "&" | "^" | "~" | "<<" | ">>" | "=>" | "!" | "satisfies" | "eof"
  // Salto de linea significativo. El lexer lo emite cuando encuentra \n
  // fuera de strings/comentarios; el parser lo usa como terminador
  // alternativo de statement (junto con ';' y '}').
  | "newline"
  // V19: modificadores de encapsulación.
  | "private" | "public" | "protected"
  // V22-gap-#1: `import type` en el parser (consume solo los tokens).
  | "import";

export interface Token { kind: TokenKind; lexeme: string; span: Span }

export const KEYWORDS: Readonly<Record<string, TokenKind>> = Object.assign(Object.create(null), {
  let: "let", const: "const", function: "function", interface: "interface", class: "class", new: "new", return: "return", if: "if", else: "else",
  while: "while", for: "for", break: "break", continue: "continue", extends: "extends", export: "export", true: "true", false: "false", out: "out", async: "async", await: "await", using: "using", number: "type", string: "type", boolean: "type", void: "type", type: "type", satisfies: "satisfies",
  enum: "enum", switch: "switch", case: "case", default: "default", of: "of", in: "in", delete: "delete", instanceof: "instanceof", typeof: "typeof", readonly: "readonly", union: "union",
  // V22-gap-#1: `import` se reconoce como keyword para soportar
  // `import type { ... } from "..."`.
  import: "import",
  // V19: modificadores de encapsulación.
  private: "private", public: "public", protected: "protected",
});
