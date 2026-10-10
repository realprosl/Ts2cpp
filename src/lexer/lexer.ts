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
  // Profundidad de anidamiento de (), [] y {}. Dentro de estos contextos
  // el lexer NO emite tokens 'newline', porque expresiones/objetos/bloques
  // pueden tener saltos de linea arbitrarios sin que terminen statements.
  // (Esto resuelve 'f()\n.bar()' sin ambiguedad.)
  // El lexer no procesa {} como bloque de control de flujo: eso lo hace
  // el parser. Aqui solo contamos los {} que abrimos como parte de un
  // object literal (que el parser decide). PERO como el lexer no sabe
  // si un { es object literal o bloque, lo cuenta siempre y luego
  // emite el 'newline' solo a profundidad 0.
  private parenDepth = 0;

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
    let newlines = 0;
    for (;;) {
      while (/\s/.test(this.peek())) {
        if (this.peek() === "\n") { newlines++; this.advance(); }
        else this.advance();
      }
      if (this.peek() === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") this.advance();
      } else if (this.peek() === "/" && this.peek(1) === "*") {
        this.advance(); this.advance();
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
          if (this.peek() === "\n") newlines++;
          this.advance();
        }
        if (!this.atEnd()) { this.advance(); this.advance(); }
      } else break;
    }
    // Emitir UN token 'newline' si hemos cruzado saltos de linea, pero SOLO
    // a profundidad 0 de parentesis/corchetes. Las {} NO cuentan porque
    // pueden ser tanto object literals (donde los newlines entre campos
    // son whitespace inocuo) como bloques de control de flujo (donde los
    // newlines entre statements SI son terminadores). El parser decide
    // segun el contexto.
    //
    // Ademas: si el siguiente token (no-whitespace) es un CONTINUADOR de
    // expresion (es decir, un operador o un member access), tampoco se
    // emite newline. Esto resuelve el caso de method chains multilinea:
    //   numbers
    //     .filter(...)
    //     .map(...)
    //   sin tener que marcar el '.' como parte de un token multi-char.
    //
    // La lista de continuadores coincide con los operadores que pueden
    // aparecer al INICIO de un nuevo token despues de una expresion
    // terminada: member access (.), call ( (), array index ( [ ), binary
    // ops ( + - * / % < > = ! ? : | & ^ ~ ), y el lambda =>. Los
    // asignadores (=, ==, !=, etc.) tambien cuentan porque el usuario
    // puede dividir una declaracion multilinea:
    //   let x =
    //     computeX()
    if (newlines > 0 && this.parenDepth === 0) {
      const next = this.peekNonWhitespace();
      const continuators = new Set([".", "(", "[", "+", "-", "*", "/", "%", "=", "?", ":", "<", ">", "!", "&", "|", "^", "~", "&&", "||", "??", "?."]);
      const isTwoChar = continuators.has(next + this.peek(1));
      const isOneChar = continuators.has(next);
      if (!isOneChar && !isTwoChar) {
        const pos = this.position();
        this.tokens.push({ kind: "newline", lexeme: "\n", span: span(pos, pos) });
      }
    }
  }

  // Avanza el puntero sobre whitespace y comentarios, sin consumir tokens,
  // y devuelve el siguiente char no-whitespace. Se usa para lookahead
  // en skipTrivia() cuando decidimos si emitir un token 'newline'.
  private peekNonWhitespace(): string {
    let i = this.offset;
    while (i < this.source.length) {
      const c = this.source[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
      // Comentario de linea: se ignora, pero el '\n' que viene despues
      // ya se ha consumido arriba (cruzamos newlines). Para mirar mas
      // alla de un comentario de linea saltamos hasta el proximo char
      // no whitespace (que sera de la linea siguiente).
      if (c === "/" && this.source[i + 1] === "/") {
        while (i < this.source.length && this.source[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && this.source[i + 1] === "*") {
        i += 2;
        while (i < this.source.length - 1 && !(this.source[i] === "*" && this.source[i + 1] === "/")) i++;
        if (i < this.source.length - 1) i += 2;
        continue;
      }
      return c;
    }
    return "";
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
    if (singles.includes(one)) {
      this.add(one as TokenKind, one, start);
      // Track de profundidad de () y [] para suprimir 'newline' tokens
      // dentro de expresiones (llamadas a funciones, argumentos, array
      // literals). NO contamos {} porque:
      //   - { ... } de object literal SI permite newlines entre campos
      //     (que actuan como ',' separadores).
      //   - { ... } de bloque de control de flujo (if/while/for/match)
      //     tambien necesita newlines entre statements internos.
      // El parser decide si ignorar o consumir los newlines segun el
      // contexto.
      if (one === "(" || one === "[") this.parenDepth++;
      else if (one === ")" || one === "]") {
        if (this.parenDepth > 0) this.parenDepth--;
      }
    }
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
