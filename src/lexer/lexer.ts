import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { span, type Position } from "../core/span.ts";
import { KEYWORDS, type Token, type TokenKind } from "./token.ts";

export class Lexer {
  private readonly source: string;
  private offset = 0;
  private line = 1;
  private column = 1;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];

  constructor(source: string) { this.source = source; }

  tokenize(): Token[] {
    while (!this.atEnd()) {
      this.skipTrivia();
      if (this.atEnd()) break;
      const start = this.position();
      const c = this.peek();
      if (/[A-Za-z_]/.test(c)) this.identifier(start);
      else if (/[0-9]/.test(c)) this.number(start);
      else if (c === '"' || c === "'") this.string(start);
      else if (c === "`") this.template(start);
      else this.symbol(start);
    }
    const pos = this.position();
    this.tokens.push({ kind: "eof", lexeme: "", span: span(pos, pos) });
    if (this.diagnostics.length) throw new DiagnosticError(this.diagnostics);
    return this.tokens;
  }

  private skipTrivia(): void {
    for (;;) {
      while (/\s/.test(this.peek())) this.advance();
      if (this.peek() === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") this.advance();
      } else if (this.peek() === "/" && this.peek(1) === "*") {
        this.advance(); this.advance();
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
        if (!this.atEnd()) { this.advance(); this.advance(); }
      } else break;
    }
  }

  private identifier(start: Position): void {
    let value = "";
    while (/[A-Za-z0-9_]/.test(this.peek())) value += this.advance();
    this.add(KEYWORDS[value] ?? "identifier", value, start);
  }

  private number(start: Position): void {
    let value = "";
    // Reconoce prefijos numéricos no decimales:
    //   0xFF 0xff 0X1A    -> hexadecimal
    //   0o77  0O7         -> octal
    //   0b101 0B0         -> binario
    //   1_000_000         -> separadores '_' (TS moderno), válidos entre dígitos
    if (this.peek() === "0" && /[xXoObB]/.test(this.peek(1))) {
      const prefix = this.advance() + this.advance();
      value = prefix;
      let charset: RegExp;
      if (/[xX]/.test(prefix[1])) charset = /[0-9a-fA-F_]/;
      else if (/[oO]/.test(prefix[1])) charset = /[0-7_]/;
      else charset = /[01_]/;
      while (charset.test(this.peek())) value += this.advance();
      // Rechaza caracteres válidos para decimal pero no para el prefijo actual
      // (p.ej. `0x12g`): el lexer ya paró en el primer char inválido, así que
      // no hay nada más que hacer aquí. La conversión a número ocurre en el
      // codegen (que prefiere el literal original cuando está disponible).
    } else {
      while (/[0-9_]/.test(this.peek())) value += this.advance();
      if (this.peek() === "." && /[0-9]/.test(this.peek(1))) {
        value += this.advance();
        while (/[0-9_]/.test(this.peek())) value += this.advance();
      }
    }
    this.add("number", value, start);
  }

  private string(start: Position): void {
    const quote = this.advance();
    let value = "";
    while (!this.atEnd() && this.peek() !== quote) {
      if (this.peek() === "\n") break;
      if (this.peek() === "\\") {
        this.advance();
        const escaped = this.advance();
        value += ({ n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'" } as Record<string, string>)[escaped] ?? escaped;
      } else value += this.advance();
    }
    if (this.peek() !== quote) {
      this.diagnostics.push({ phase: "lexer", message: "Cadena sin cerrar", span: span(start, this.position()) });
      return;
    }
    this.advance();
    this.add("string", value, start);
  }

  // Template literal: lee el contenido crudo entre backticks. NO tokeniza las
  // expresiones dentro de `${...}`; las guarda tal cual para que el parser las
  // re-lexee y parsee recursivamente. Lleva un contador de profundidad para
  // soportar `${ `${inner}` }` y plantillas anidadas.
  private template(start: Position): void {
    this.advance(); // backtick de apertura
    let raw = "";
    let depth = 0;
    while (!this.atEnd()) {
      const c = this.peek();
      if (depth === 0 && c === "`") {
        this.advance();
        this.add("template", raw, start);
        return;
      }
      if (c === "\\") {
        raw += this.advance();
        if (!this.atEnd()) raw += this.advance();
        continue;
      }
      if (c === "$" && this.peek(1) === "{") {
        raw += this.advance();
        raw += this.advance();
        depth++;
        continue;
      }
      if (c === "}" && depth > 0) {
        raw += this.advance();
        depth--;
        continue;
      }
      raw += this.advance();
    }
    this.diagnostics.push({ phase: "lexer", message: "Template sin cerrar", span: span(start, this.position()) });
  }

  private symbol(start: Position): void {
    if (this.peek() + this.peek(1) + this.peek(2) === "...") {
      this.advance(); this.advance(); this.advance(); this.add("...", "...", start); return;
    }
    const two = this.peek() + this.peek(1);
    const doubles: TokenKind[] = ["==", "!=", "<=", ">=", "&&", "||", "=>", "??", "?."];
    if (doubles.includes(two as TokenKind)) {
      this.advance(); this.advance(); this.add(two as TokenKind, two, start); return;
    }
    const one = this.advance();
    const singles = "(){}[] ,;:.-+*/%=<>!?|&^~@".replace(" ", "");
    if (singles.includes(one)) this.add(one as TokenKind, one, start);
    else this.diagnostics.push({ phase: "lexer", message: `Carácter inesperado '${one}'`, span: span(start, this.position()) });
  }

  private add(kind: TokenKind, lexeme: string, start: Position): void { this.tokens.push({ kind, lexeme, span: span(start, this.position()) }); }
  private atEnd(): boolean { return this.offset >= this.source.length; }
  private peek(ahead = 0): string { return this.source[this.offset + ahead] ?? "\0"; }
  private advance(): string {
    const c = this.source[this.offset++] ?? "\0";
    if (c === "\n") { this.line++; this.column = 1; } else this.column++;
    return c;
  }
  private position(): Position { return { offset: this.offset, line: this.line, column: this.column }; }
}
