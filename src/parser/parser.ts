import type { Program, Statement, Expression, Expression as Expr, TypeName, BlockStatement, Parameter, InterfaceMethod, ClassField, ClassMethod, TemplateLiteralExpression, TypeParameter, TypeAliasDeclaration, EnumDeclaration, EnumMember, LiteralExpression, ArrayElement, SpreadElement, Decorator, MatchExpression, MatchArm, UnionDeclaration, UnionVariant, ExportDefaultDeclaration, ExportNamedDeclaration, ExportSpecifier } from "../ast/nodes.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { span } from "../core/span.ts";
import { Lexer } from "../lexer/lexer.ts";
import type { Token, TokenKind } from "../lexer/token.ts";
import { arrayType, functionType, genericType, readonlyType, tupleType, typeofType } from "../types/type-system.ts";

const PRECEDENCE: Partial<Record<TokenKind, number>> = { "??": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, "<=": 5, ">": 5, ">=": 5, "instanceof": 5, "|": 6, "&": 6, "^": 6, "<<": 6, ">>": 6, "+": 7, "-": 7, "*": 8, "/": 8, "%": 8 };

export class Parser {
  private readonly tokens: Token[];
  private current = 0;
  private readonly diagnostics: Diagnostic[] = [];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  parseProgram(): Program {
    const statements: Statement[] = [];
    // Saltamos los newlines iniciales por si el archivo empieza con lineas
    // en blanco o comentarios entre statements. La semantica de newline
    // significativo la gestiona cada statement internamente.
    this.skipNewlines();
    // V18: los `.lib.ets` empiezan con cero o más declaraciones `ModuleHeader`.
    // El bloque ModuleHeader agrupa SOLO `@link` / `@include` (declaraciones
    // a nivel de archivo). Otros decoradores (`@cpp_name`, `@cpp_type`)
    // pertenecen al statement siguiente y NO se acumulan aquí.
    //
    // Para distinguirlos sin consumir, "espiamos" el nombre del decorador
    // (primer identificador tras `@`) sin avanzar y solo consumimos si es
    // un header decorator.
    const headerDecorators: Decorator[] = [];
    while (this.check("@")) {
      const nameToken = this.peekAt(1);
      if (!nameToken || nameToken.kind !== "identifier" || (nameToken.lexeme !== "link" && nameToken.lexeme !== "include")) break;
      // Consumimos UN solo decorador (`@link(...)` o `@include(...)`) sin
      // consumir los siguientes. Para ello llamamos a una versión "single"
      // de parseDecorators: lee el `@`, el nombre y los args, sin buclear.
      headerDecorators.push(this.parseSingleDecorator());
      // Saltamos los newlines que pueda haber entre el ultimo header
      // decorator y el siguiente, igual que en parseDecorators() para
      // los decorators a nivel de statement.
      this.skipNewlines();
    }
    if (headerDecorators.length > 0) {
      const lastToken = this.tokens[this.current - 1] ?? headerDecorators.at(-1)!;
      statements.push({ kind: "ModuleHeaderDeclaration", decorators: headerDecorators, span: span(this.tokens[0].span.start, lastToken.span.end) });
    }
    // El bucle principal: saltamos newlines (lineas en blanco) ANTES de
    // chequear eof, porque entre statements puede haber multiples newlines
    // que no cuentan como contenido. Esto evita confundir una linea en
    // blanco al final del archivo con un statement vacio.
    while (true) {
      this.skipNewlines();
      if (this.check("eof")) break;
      statements.push(this.statement(true));
    }
    if (this.diagnostics.length) throw new DiagnosticError(this.diagnostics);
    return { kind: "Program", statements, span: span(this.tokens[0].span.start, this.peek().span.end) };
  }

  private statement(topLevel = false): Statement {
    // Los saltos de linea entre statements son whitespace a nivel de
    // parsing: los salta ANTES de intentar reconocer el siguiente
    // statement. La semantica de "newline = ;" ya la gestiona
    // consumeStatementTerminator() en cada caso.
    this.skipNewlines();
    // V18: decoradores (`@cpp_name(...)`) pueden ir ANTES o DESPUÉS de `export`.
    // Probamos ambas posiciones; el que consuma tokens primero gana.
    const leadingDecorators = this.parseDecorators();
    const exported = this.match("export");
    if (exported && !topLevel) this.error(this.previous(), "'export' solo es válido en el nivel superior de un módulo");
    if (this.match("let", "const")) return this.variable(this.previous(), exported, leadingDecorators);
    if (this.match("using")) return this.usingDeclaration(this.previous(), exported);
    if (this.match("async")) {
      const keyword = this.previous();
      this.consume("function", "'async' solo puede preceder a una función");
      return this.functionDeclaration(keyword, true, exported, leadingDecorators);
    }
    if (this.match("function")) return this.functionDeclaration(this.previous(), false, exported, leadingDecorators);
    if (this.match("interface")) return this.interfaceDeclaration(this.previous(), exported, leadingDecorators);
    if (this.match("class")) return this.classDeclaration(false, exported, leadingDecorators);
    if (this.match("type")) return this.typeAliasDeclaration(this.previous(), exported);
    if (this.match("enum")) return this.enumDeclaration(this.previous(), exported);
    if (this.match("union")) return this.unionDeclaration(this.previous(), exported);
    // V22-gap-#1: `import type { Foo } from "..."` se trata como un
    // statement vacío. El módulo-loader extrae los símbolos por regex
    // antes de mandar al parser, así que el AST no necesita preservar
    // la información de imports. Solo necesitamos consumir los tokens.
    if (this.match("import")) return this.importStatement();
    if (exported) {
      if (this.match("default")) return this.exportDefaultDeclaration();
      if (this.match("{")) return this.exportNamedDeclaration();
    }
    if (exported) this.error(this.peek(), "'export' debe preceder a let, const, function, async function, interface o class");
    if (this.match("if")) return this.ifStatement(this.previous());
    if (this.match("while")) return this.whileStatement(this.previous());
    if (this.match("for")) {
      const keyword = this.previous();
      // `for await (const x of iterable)` — `await` opcional entre `for` y `(`.
      const awaitToken = this.match("await");
      this.consume("(", "Se esperaba '(' después de 'for'");
      // Detecta `for..of` / `for..in` mirando hacia adelante dentro del paréntesis:
      // la presencia de `of` / `in` como identifier a profundidad 1 distingue el
      // bucle estilo TypeScript del clásico `for(init; cond; incr)`.
      const kind = this.lookAheadForOfOrIn();
      if (kind === "of") return this.forOfStatement(keyword, awaitToken ? this.previous() : undefined);
      if (kind === "in") {
        if (awaitToken) this.error(this.previous(), "'for await...in' no se admite; solo 'for await...of'");
        return this.forInStatement(keyword);
      }
      if (awaitToken) this.error(this.previous(), "'await' solo es válido con 'for...of'");
      return this.forStatement(keyword);
    }
    if (this.match("break", "continue")) {
      const keyword = this.previous(); const end = this.consumeStatementTerminator(`Se esperaba ';' después de ${keyword.lexeme}`);
      return { kind: keyword.kind === "break" ? "BreakStatement" : "ContinueStatement", span: span(keyword.span.start, end.span.end) };
    }
    if (this.match("return")) return this.returnStatement(this.previous());
    if (this.match("{")) return this.block(this.previous());
    if (this.match("delete")) return this.deleteStatement(this.previous());
    const expr = this.expression();
    const end = this.consumeStatementTerminator("Se esperaba ';' después de la expresión");
    return { kind: "ExpressionStatement", expression: expr, span: span(expr.span.start, end.span.end) };
  }

  private deleteStatement(keyword: Token): Statement {
    const target = this.expression();
    if (target.kind !== "IndexExpression") this.error(target.span, "delete requiere un acceso por índice (map[k], set[v], arr[i])");
    const end = this.consumeStatementTerminator("Se esperaba ';' después de 'delete'");
    return { kind: "DeleteStatement", target: target as IndexExpression, span: span(keyword.span.start, end.span.end) };
  }

  private variable(keyword: Token, exported = false, leadingDecorators: Decorator[] = []): Statement {
    // Destructuring de arrays: `const [a, b, c] = expr;` con soporte para
    // default values (`const [a = 5, b = "x"] = arr`) y tipos declarados
    // (`const [a: number, b: string] = arr`).
    if (this.check("[")) {
      const open = this.advance();
      const bindings: ArrayBinding[] = [];
      while (!this.check("]")) {
        const ident = this.consume("identifier", "Se esperaba un identificador en el patrón de destructuring");
        let declaredType: TypeName | undefined;
        if (this.match(":")) declaredType = this.typeName();
        let defaultValue: Expression | undefined;
        if (this.match("=")) defaultValue = this.expression();
        bindings.push({ name: ident.lexeme, declaredType, defaultValue });
        if (!this.match(",")) break;
      }
      const close = this.consume("]", "Se esperaba ']' después del patrón de destructuring");
      let declaredType: TypeName | undefined;
      if (this.match(":")) declaredType = this.typeName();
      this.consume("=", "Toda variable debe tener un inicializador");
      const initializer = this.expression();
      const end = this.consumeStatementTerminator("Se esperaba ';' después de la declaración");
      return { kind: "VariableDeclaration", exported, mutable: keyword.kind === "let", name: "", declaredType, initializer, arrayBindings: bindings, span: span(keyword.span.start, end.span.end) };
    }
    const name = this.consume("identifier", "Se esperaba el nombre de la variable");
    let declaredType: TypeName | undefined;
    if (this.match(":")) declaredType = this.typeName();
    this.consume("=", "Toda variable debe tener un inicializador");
    const initializer = this.expression();
    const end = this.consumeStatementTerminator("Se esperaba ';' después de la declaración");
    // V28: si el usuario puso decoradores antes de `let`, los guardamos
    // aqui. El codegen los consulta para, por ejemplo, detectar
    // `@cpp_drogon` sobre `let server: Server = http.createServer()`.
    const decorators = leadingDecorators.length > 0 ? leadingDecorators : undefined;
    return { kind: "VariableDeclaration", exported, mutable: keyword.kind === "let", name: name.lexeme, declaredType, initializer, decorators, span: span(keyword.span.start, end.span.end) };
  }

  /**
   * `using name = expr;` (TC39 stage 3): declara un recurso cuyo destructor
   * se invoca al final del bloque. En el dialecto es syntactic sugar sobre
   * `let name = expr;` con la garantía de RAII automático. Si el tipo declara
   * un método `dispose()`, el codegen lo invoca explícitamente al final del
   * bloque; si no, el destructor C++ se encarga (tipos runtime ya son RAII).
   */
  private usingDeclaration(keyword: Token, exported = false): Statement {
    const name = this.consume("identifier", "Se esperaba el nombre del recurso en 'using'");
    let declaredType: TypeName | undefined;
    if (this.match(":")) declaredType = this.typeName();
    this.consume("=", "Toda declaración 'using' debe tener un inicializador");
    const initializer = this.expression();
    const end = this.consumeStatementTerminator("Se esperaba ';' después de la declaración 'using'");
    return { kind: "UsingDeclaration", exported, name: name.lexeme, declaredType, initializer, span: span(keyword.span.start, end.span.end) };
  }

  private functionDeclaration(keyword: Token, isAsync: boolean, exported = false, leadingDecorators: Decorator[] = []): Statement {
    // V18: decoradores pueden venir antes de la palabra clave (consumidos
    // en `statement()`) o justo aquí. Se concatenan con los leading.
    const inlineDecorators = this.parseDecorators();
    const decorators = [...leadingDecorators, ...inlineDecorators];
    const name = this.consume("identifier", "Se esperaba el nombre de la función");
    const generics = this.typeParameterNames();
    this.consume("(", "Se esperaba '('");
    const params: Parameter[] = [];
    if (!this.check(")")) do {
      const variadic = this.match("...");
      const out = this.match("out");
      // V22 (Memory Model v2): el modificador `mut` ya no existe.
      // Si aparece, emitimos E4400 y lo consumimos para continuar parseando.
      if (this.match("mut")) this.error(this.previous(), "E4400: 'mut' has been removed. Use ref<T> for an explicit mutable reference, or constRef<T> for a readonly borrow.");
      if (out && this.check("mut")) this.error(this.previous(), "Un parámetro no puede ser out y mut a la vez");
      const p = this.consume("identifier", "Se esperaba el nombre del parámetro");
      const optional = this.match("?");
      this.consume(":", "El parámetro necesita un tipo");
      const type = this.typeName();
      const defaultValue = this.match("=") ? this.expression() : undefined;
      params.push({ name: p.lexeme, type, out, passing: out ? "out" : "value", variadic, defaultValue, optional, span: p.span });
    } while (this.match(","));
    this.consume(")", "Se esperaba ')' después de los parámetros");
    this.consume(":", "La función necesita un tipo de retorno");
    const returnType = this.typeName();
    // V18: declaración sin cuerpo (forward declaration estilo `.d.ts`).
    // Si la firma va seguida de `;` en lugar de `{`, emitimos un body
    // sintético vacío y marcamos el nodo para que el codegen NO genere
    // cuerpo (solo `extern` cuando tenga decorador `@cpp_name`).
    if (this.match(";")) {
      const semi = this.previous();
      const emptyBody: BlockStatement = { kind: "BlockStatement", statements: [], span: span(semi.span.start, semi.span.end) };
      const node: Statement = { kind: "FunctionDeclaration", exported, name: name.lexeme, async: isAsync, typeParameters: generics.parameters, variadicTypeParameters: generics.variadic, params, returnType, body: emptyBody, decorators, span: span(keyword.span.start, semi.span.end) };
      // El codegen consultará `decorators` para emitir `extern` si la
      // declaración estaba asociada a una librería externa.
      return node;
    }
    const open = this.consume("{", "Se esperaba el cuerpo de la función");
    const body = this.block(open);
    return { kind: "FunctionDeclaration", exported, name: name.lexeme, async: isAsync, typeParameters: generics.parameters, variadicTypeParameters: generics.variadic, params, returnType, body, decorators, span: span(keyword.span.start, body.span.end) };
  }

  private interfaceDeclaration(keyword: Token, exported = false, leadingDecorators: Decorator[] = []): Statement {
    // V18: `@cpp_type("Vector2")` antes de la interface. Decoradores
    // pueden venir antes (leading) o aquí (inline).
    const inlineDecorators = this.parseDecorators();
    const decorators = [...leadingDecorators, ...inlineDecorators];
    const name = this.consume("identifier", "Se esperaba el nombre de la interfaz");
    const open = this.consume("{", "Las interfaces son estructurales y no admiten herencia; se esperaba '{'");
    const methods: InterfaceMethod[] = [];
    while (!this.check("}") && !this.check("eof")) {
      // V18: `@cpp_name(...)` por método de la interface.
      const methodDecorators = this.parseDecorators();
      const methodName = this.consume("identifier", "Se esperaba el nombre del método");
      this.consume("(", "Se esperaba '('");
      const params: Parameter[] = [];
      if (!this.check(")")) do {
        const out = this.match("out");
        // V22: `mut` eliminado. Consumir + diagnosticar.
        if (this.match("mut")) this.error(this.previous(), "E4400: 'mut' has been removed. Use ref<T> for an explicit mutable reference, or constRef<T> for a readonly borrow.");
        const parameter = this.consume("identifier", "Se esperaba el nombre del parámetro");
        const optional = this.match("?");
        this.consume(":", "El parámetro necesita un tipo");
        const type = this.typeName();
        const defaultValue = this.match("=") ? this.expression() : undefined;
        params.push({ name: parameter.lexeme, type, out, passing: out ? "out" : "value", defaultValue, optional, span: parameter.span });
      } while (this.match(","));
      this.consume(")", "Se esperaba ')' después de los parámetros");
      this.consume(":", "El método necesita un tipo de retorno");
      const returnType = this.typeName();
      const end = this.consumeStatementTerminator("Se esperaba ';' después del método");
      methods.push({ name: methodName.lexeme, params, returnType, decorators: methodDecorators, span: span(methodName.span.start, end.span.end) });
    }
    const close = this.consume("}", "Se esperaba '}' después de la interfaz");
    return { kind: "InterfaceDeclaration", exported, name: name.lexeme, methods, decorators, span: span(keyword.span.start, close.span.end) };
  }

  private classDeclaration(keywordAlreadyConsumed: boolean, exported = false): Statement {
    const decorators = this.parseDecorators();
    if (keywordAlreadyConsumed) this.consume("class", "Se esperaba 'class' antes del nombre");
    const name = this.consume("identifier", "Se esperaba el nombre de la clase");
    const generics = this.typeParameterNames();
    this.consume("{", "Las clases no admiten herencia; se esperaba '{'");
    const fields: ClassField[] = [];
    const methods: ClassMethod[] = [];
    const startSpan = decorators[0]?.args[0]?.span.start ?? name.span.start;
    while (!this.check("}") && !this.check("eof")) {
      this.skipNewlines();
      if (this.check("}") || this.check("eof")) break;
      const memberDecorators = this.parseDecorators();
      // V19: modificador de encapsulación opcional (private/public/protected).
      // Va antes de readonly y antes del nombre. Si se omite, default = public.
      const access: "private" | "public" | "protected" | undefined =
        this.match("private") ? "private"
        : this.match("public") ? "public"
        : this.match("protected") ? "protected"
        : undefined;
      const readonly = this.match("readonly");
      const member = this.consume("identifier", "Se esperaba un campo o método");
      if (this.match(":")) {
        const type = this.typeName();
        const end = this.consumeStatementTerminator("Se esperaba ';' después del campo");
        fields.push({ name: member.lexeme, type, readonly, access, decorators: memberDecorators, span: span(member.span.start, end.span.end) });
      } else {
        const generics = this.typeParameterNames();
        this.consume("(", "Se esperaba '(' en el método");
        const params: Parameter[] = [];
        if (!this.check(")")) do {
          const out = this.match("out");
          // V22: `mut` eliminado.
          if (this.match("mut")) this.error(this.previous(), "E4400: 'mut' has been removed. Use ref<T> for an explicit mutable reference, or constRef<T> for a readonly borrow.");
          // V19: parameter properties. Si el parámetro tiene modificador de
          // acceso o readonly, se convierte en un campo de la misma clase.
          const paramAccess: "private" | "public" | "protected" | undefined =
            this.match("private") ? "private"
            : this.match("public") ? "public"
            : this.match("protected") ? "protected"
            : undefined;
          const paramReadonly = this.match("readonly");
          const parameter = this.consume("identifier", "Se esperaba el nombre del parámetro");
          const optional = this.match("?");
          this.consume(":", "El parámetro necesita un tipo");
          const type = this.typeName();
          const defaultValue = this.match("=") ? this.expression() : undefined;
          params.push({
            name: parameter.lexeme,
            type,
            out,
            passing: out ? "out" : "value",
            defaultValue,
            optional,
            // V19: si tiene modificador o readonly, es un parameter property.
            access: paramAccess,
            readonly: paramReadonly,
            span: parameter.span,
          });
        } while (this.match(","));
        this.consume(")", "Se esperaba ')' después de los parámetros");
        const isConstructor = member.lexeme === "constructor";
        const returnType: TypeName = isConstructor ? "void" : (this.match(":") ? this.typeName() : (this.error(this.peek(), "El método necesita un tipo de retorno"), "void"));
        const open = this.consume("{", "Se esperaba el cuerpo del método");
        const body = this.block(open);
        methods.push({ name: member.lexeme, typeParameters: generics.parameters, params, returnType, body, decorators: memberDecorators, access, span: span(member.span.start, body.span.end) });
      }
    }
    const close = this.consume("}", "Se esperaba '}' después de la clase");
    return { kind: "ClassDeclaration", exported, name: name.lexeme, typeParameters: generics.parameters, variadicTypeParameters: generics.variadic, fields, methods, decorators, span: span(startSpan, close.span.end) };
  }

  /**
   * Lee cero o más decoradores `@name(args)` y los devuelve como una lista.
   * Si el token `@` no aparece, devuelve `[]`. Los decoradores se aplican
   * al siguiente elemento (clase, método o campo) que se parsee.
   */
  private parseSingleDecorator(): Decorator {
    this.advance(); // consume `@`
    const name = this.consume("identifier", "Se esperaba el nombre del decorador tras '@'");
    const args: Expression[] = [];
    if (this.match("(")) {
      if (!this.check(")")) do { args.push(this.expression()); } while (this.match(","));
      this.consume(")", "Se esperaba ')' después de los argumentos del decorador");
    }
    return { name: name.lexeme, args };
  }
  private parseDecorators(): Decorator[] {
    const decorators: Decorator[] = [];
    while (this.check("@")) {
      this.advance();
      const name = this.consume("identifier", "Se esperaba el nombre del decorador tras '@'");
      const args: Expression[] = [];
      if (this.match("(")) {
        if (!this.check(")")) do { args.push(this.expression()); } while (this.match(","));
        this.consume(")", "Se esperaba ')' después de los argumentos del decorador");
      }
      decorators.push({ name: name.lexeme, args });
      // Saltamos los newlines que pueda haber entre decorators
      // consecutivos. Sin esto, el parser trata cada decorator como
      // un statement independiente y falla con "Se esperaba una
      // expresión" en la linea del siguiente @.
      this.skipNewlines();
    }
    return decorators;
  }

  // `type X = T` o `type X<A extends B> = T`. El cuerpo es una única expresión
  // de tipo (union/intersection se parsean en el sufijo de `typeName`).
  private typeAliasDeclaration(keyword: Token, exported = false): Statement {
    const name = this.consume("identifier", "Se esperaba el nombre del alias de tipo");
    const typeParameters: TypeParameter[] = [];
    if (this.match("<")) {
      do {
        const nameTok = this.consume("identifier", "Se esperaba un parámetro de tipo");
        const param: TypeParameter = { name: nameTok.lexeme, span: nameTok.span };
        if (this.match("extends")) param.constraint = this.typeName();
        if (this.match("=")) param.default = this.typeName();
        typeParameters.push(param);
      } while (this.match(","));
      this.consume(">", "Se esperaba '>' después de los parámetros de tipo");
    }
    this.consume("=", "Se esperaba '=' en la declaración de alias de tipo");
    const type = this.typeName();
    const end = this.consumeStatementTerminator("Se esperaba ';' después del alias de tipo");
    return { kind: "TypeAliasDeclaration", exported, name: name.lexeme, typeParameters, type, span: span(keyword.span.start, end.span.end) };
  }

  // `enum X { Member1, Member2 = expr, ... }`. Soporta enums numéricos (auto-incremento
  // desde 0, valores explícitos opcionales) y de cadena (todos los miembros deben tener
  // valor explícito). Se rechazan enums mixtos y valores computados.
  // `export default <decl-or-expr>;`. Parsea el cuerpo como una declaración
  // completa (let/const/class/function) o una expresión, terminada por ';'.
  // El dialecto emite un marcador `// export default: <kind>` en C++ pero
  // compila normalmente (single-translation-unit no necesita dispatch).
  private exportDefaultDeclaration(): ExportDefaultDeclaration {
    const start = this.previous().span.start;
    let declaration: Statement | Expression;
    if (this.match("class")) {
      declaration = this.classDeclaration(true, false);
    } else if (this.match("function")) {
      declaration = this.functionDeclaration(this.previous(), false, false);
    } else if (this.match("async")) {
      this.match("function");
      declaration = this.functionDeclaration(this.previous(), true, false);
    } else if (this.match("let", "const")) {
      declaration = this.variable(this.previous(), false);
    } else {
      declaration = this.expression();
      this.consumeStatementTerminator("Se esperaba ';' después de la expresión de 'export default'");
    }
    const endSpan = (declaration as { span?: import("../core/span.ts").Span }).span;
    return { kind: "ExportDefaultDeclaration", declaration, span: span(start, endSpan?.end ?? start) };
  }

  // `export { name1, name2 as alias2, ... };`. Marca los bindings como
  // exportados sin generar código nuevo (ya están declarados arriba).
  // V22-gap-#1: `import type { ... } from "..."` — consumido como statement vacío.
  // El módulo-loader extrae los símbolos por regex sobre el texto fuente,
  // así que el AST no necesita preservar los símbolos importados.
  private importStatement(): Statement {
    const start = this.previous().span.start;
    // Sintaxis permitida:
    //   import { Foo, Bar } from "baz";
    //   import type { Foo, Bar } from "baz";
    //   import { Foo, Bar as Alias } from "baz";
    //   import "baz";   (side-effect import, lo permitimos por compatibilidad)
    this.match("type");
    if (this.match("{")) {
      while (!this.check("}") && !this.check("eof")) {
        this.match("type");
        if (this.match("identifier")) {
          // Soporta `Foo as Alias`.
          if (this.peek().kind === "identifier" && this.peek().lexeme === "as") {
            this.advance(); // consume `as`
            if (this.check("identifier")) this.advance();
          }
        } else if (!this.check(",")) {
          break;
        }
        this.match(",");
      }
      this.match("}");
      // Soporta `from "..."`.
      if (this.check("identifier") && this.peek().lexeme === "from") this.advance();
    }
    if (this.check("string")) this.advance();
    this.match(";");
    const end = this.previous().span.end;
    return { kind: "ExpressionStatement", expression: { kind: "LiteralExpression", value: 0, literalType: "number", span: { start, end } }, span: { start, end } };
  }

  private exportNamedDeclaration(): ExportNamedDeclaration {
    const start = this.previous().span.start;
    const specifiers: ExportSpecifier[] = [];
    do {
      const nameToken = this.consume("identifier", "Se esperaba un nombre en el export");
      let alias: string | undefined;
      if (this.check("identifier") && this.peek().lexeme === "as") { this.advance(); alias = this.consume("identifier", "Se esperaba un alias después de 'as'").lexeme; }
      specifiers.push({ kind: "ExportSpecifier", name: nameToken.lexeme, alias, span: span(nameToken.span.start, this.peek().span.start) });
    } while (this.match(","));
    this.consume("}", "Se esperaba '}' al final de la lista de exports");
    let source: string | undefined;
    if (this.check("identifier") && this.peek().lexeme === "from") {
      this.advance();
      const sourceToken = this.consume("string", "Se esperaba un literal de módulo después de 'from'");
      source = (sourceToken as { literal?: string }).literal;
    }
    this.consumeStatementTerminator("Se esperaba ';' después de 'export {...}'");
    return { kind: "ExportNamedDeclaration", specifiers, source, span: span(start, this.peek().span.start) };
  }

  private enumDeclaration(keyword: Token, exported = false): Statement {
    const name = this.consume("identifier", "Se esperaba el nombre del enum");
    this.consume("{", "Se esperaba '{' después del nombre del enum");
    const members: EnumMember[] = [];
    let numericValue = 0;
    let hasString = false;
    let hasExplicitNumeric = false;
    while (!this.check("}") && !this.check("eof")) {
      const memberName = this.consume("identifier", "Se esperaba el nombre del miembro del enum");
      let value: LiteralExpression | undefined;
      if (this.match("=")) {
        const tok = this.peek();
        if (tok.kind === "number") {
          if (hasString) this.error(tok, "Un enum no puede mezclar miembros numéricos y de cadena");
          this.advance();
          const num = Number(tok.lexeme);
          if (!Number.isFinite(num) || num < 0) this.error(tok, "El valor numérico del miembro de enum debe ser no negativo");
          value = { kind: "LiteralExpression", value: num, literalType: "number", span: tok.span };
          numericValue = num + 1;
          hasExplicitNumeric = true;
        } else if (tok.kind === "string") {
          if (hasExplicitNumeric) this.error(tok, "Un enum no puede mezclar miembros numéricos y de cadena");
          this.advance();
          value = { kind: "LiteralExpression", value: tok.lexeme, literalType: "string", span: tok.span };
          hasString = true;
        } else {
          this.error(tok, "El valor del miembro de enum debe ser un literal numérico o de cadena");
          this.advance();
        }
      } else {
        if (hasString) this.error(memberName, "Un enum de cadena requiere que todos los miembros tengan un valor explícito");
        else value = { kind: "LiteralExpression", value: numericValue, literalType: "number", span: memberName.span };
        numericValue++;
      }
      members.push({ name: memberName.lexeme, value, span: span(memberName.span.start, (value ?? memberName).span.end) });
      if (!this.check("}")) this.consume(",", "Se esperaba ',' o '}' entre miembros del enum");
    }
    const close = this.consume("}", "Se esperaba '}' después del cuerpo del enum");
    if (!members.length) this.error(close, "El enum debe tener al menos un miembro");
    const underlying: "number" | "string" = hasString ? "string" : "number";
    const node: EnumDeclaration = { kind: "EnumDeclaration", exported, name: name.lexeme, members, underlying, span: span(keyword.span.start, close.span.end) };
    return node;
  }

  // V1: `union Outcome<T, E> = Ok(T) | Err(E);`. Tagged unions nativas del
  // dialecto. Cada variante tiene un nombre y opcionalmente un payload
  // (un tipo). Se emite como `std::variant<T1, T2, ...>` con discriminador.
  // V1.4: además aceptamos object-variants `{ kind: "A"; <bindings> }` o
  // `{ ok: true; value: T }`. El primer campo debe ser un literal primitivo
  // y actúa como discriminador. Los campos restantes son bindings (su tipo
  // forma el payload de la variante).
  private unionDeclaration(keyword: Token, exported = false): Statement {
    const generics = this.typeParameterNames();
    // Si no hay `<` inmediato, el orden es: nombre primero, después `<T, E>`.
    // Si hay `<` inmediato, el usuario escribió `union <T, E> = ...` que es
    // sintaxis vieja. Aceptamos ambas formas: si el primer token tras `union`
    // es `<`, los typeParameters ya están consumidos y el siguiente es nombre.
    let name: Token;
    let typeParameters = generics.parameters;
    if (this.check("identifier")) {
      name = this.consume("identifier", "Se esperaba el nombre de la unión");
      const after = this.typeParameterNames();
      typeParameters = after.parameters;
    } else {
      this.error(this.peek(), "Se esperaba el nombre de la unión");
      return { kind: "UnionDeclaration", exported, name: "", typeParameters, variants: [], span: keyword.span };
    }
    this.consume("=", "Se esperaba '=' después del nombre de la unión");
    const variants: UnionVariant[] = [];
    do {
      // V1.4: object-variant `{ ... }` se detecta por el `{` inicial.
      if (this.check("{")) {
        const variant = this.parseObjectVariant();
        variants.push(variant);
      } else {
        const variantName = this.consume("identifier", "Se esperaba el nombre de la variante");
        let payload: TypeName | undefined;
        if (this.match("(")) {
          payload = this.typeName();
          this.consume(")", "Se esperaba ')' después del payload de la variante");
        }
        variants.push({ name: variantName.lexeme, payload, span: span(variantName.span.start, (this.previous()).span.end) });
      }
    } while (this.match("|"));
    const end = this.consumeStatementTerminator("Se esperaba ';' después de la unión");
    if (!variants.length) this.error(end, "La unión debe tener al menos una variante");
    const node: UnionDeclaration = { kind: "UnionDeclaration", exported, name: name.lexeme, typeParameters, variants, span: span(keyword.span.start, end.span.end) };
    return node;
  }

  // V1.4: parsea `{ discriminatorField: literal; <bindings> }` como variante.
  // El primer campo debe ser un literal primitivo (string/number/true/false)
  // y actúa como discriminador. Los campos restantes son bindings (su tipo
  // forma el payload). El nombre de la variante se infiere del valor del
  // discriminador (si es string) o del par (campo, valor) (e.g. `ok:true` → `Ok`).
  private parseObjectVariant(): UnionVariant {
    const start = this.peek().span.start;
    this.advance(); // consume '{'
    // Primer campo obligatorio: `field: literal`.
    const discFieldTok = this.consume("identifier", "Se esperaba un campo como primer elemento de la object-variant");
    this.consume(":", "Se esperaba ':' tras el campo discriminador");
    const litTok = this.peek();
    if (litTok.kind !== "string" && litTok.kind !== "number" && litTok.kind !== "true" && litTok.kind !== "false") {
      this.error(litTok, "El discriminador de una object-variant debe ser un literal (cadena, número o booleano)");
      return { name: discFieldTok.lexeme, span: span(start, this.peek().span.end) };
    }
    this.advance();
    const discValue: string | number | boolean = litTok.kind === "string" ? litTok.lexeme
      : litTok.kind === "number" ? Number(litTok.lexeme)
      : litTok.kind === "true";
    // Inferir el nombre de la variante:
    //  - Si el discriminador es un string ("NotFound"), el nombre es ese string.
    //  - Si el discriminador es booleano en el campo `ok`, el nombre es Ok/Err.
    //  - En otros casos, usamos el nombre del campo (e.g. `kind: "NotFound"`).
    let variantName: string;
    if (typeof discValue === "string") variantName = discValue;
    else if (typeof discValue === "boolean" && discFieldTok.lexeme === "ok") variantName = discValue ? "Ok" : "Err";
    else variantName = `${discFieldTok.lexeme}_${String(discValue)}`;
    const discriminator = { field: discFieldTok.lexeme, value: discValue };
    // Bindings adicionales: `name: T` separados por `,` o `;`.
    const bindings = new Map<string, TypeName>();
    while (this.match(",", ";")) {
      const bindName = this.consume("identifier", "Se esperaba un identificador como binding");
      this.consume(":", "Se esperaba ':' tras el binding");
      const bindType = this.typeName();
      bindings.set(bindName.lexeme, bindType);
    }
    const close = this.consume("}", "Se esperaba '}' cerrando la object-variant");
    // El payload es la tupla de tipos de los bindings, o un único tipo si
    // hay exactamente uno, o void si no hay bindings.
    let payload: TypeName | undefined;
    if (bindings.size === 1) payload = [...bindings.values()][0];
    else if (bindings.size > 1) payload = tupleType([...bindings.values()]);
    return { name: variantName, payload, discriminator, span: span(start, close.span.end) };
  }

  private ifStatement(keyword: Token): Statement {
    this.consume("(", "Se esperaba '('"); const condition = this.expression(); this.consume(")", "Se esperaba ')'");
    const thenBranch = this.statement();
    const elseBranch = this.match("else") ? this.statement() : undefined;
    return { kind: "IfStatement", condition, thenBranch, elseBranch, span: span(keyword.span.start, (elseBranch ?? thenBranch).span.end) };
  }

  private whileStatement(keyword: Token): Statement {
    this.consume("(", "Se esperaba '('"); const condition = this.expression(); this.consume(")", "Se esperaba ')'");
    const body = this.statement();
    return { kind: "WhileStatement", condition, body, span: span(keyword.span.start, body.span.end) };
  }

  private forStatement(keyword: Token): Statement {
    // El dispatcher ya consumió el `(` de apertura.
    let initializer: import("../ast/nodes.ts").VariableDeclaration | import("../ast/nodes.ts").ExpressionStatement | undefined;
    if (this.match(";")) initializer = undefined;
    else if (this.match("let", "const")) initializer = this.variable(this.previous()) as import("../ast/nodes.ts").VariableDeclaration;
    else {
      const expression = this.expression(); const end = this.consumeStatementTerminator("Se esperaba ';' después del inicializador de for"); 
      initializer = { kind: "ExpressionStatement", expression, span: span(expression.span.start, end.span.end) };
    }
    const condition = this.check(";") ? undefined : this.expression();
    // El ';' aqui es un separador interno del for (init; cond; update),
    // no un terminador de statement. NO se acepta newline: la gramatica
    // C-style de 3 componentes exige ';' literal entre ellos.
    this.consume(";", "Se esperaba ';' después de la condición de for");
    const increment = this.check(")") ? undefined : this.expression();
    this.consume(")", "Se esperaba ')' después de for");
    const body = this.statement();
    return { kind: "ForStatement", initializer, condition, increment, body, span: span(keyword.span.start, body.span.end) };
  }

  private forOfStatement(keyword: Token, awaited: Token | undefined): Statement {
    // Patrón: `for ( let|const IDENT [ : TYPE ] of EXPR ) STMT`
    // El flag `awaited` indica `for await (const x of iterable)`.
    if (!this.match("let", "const")) this.error(this.peek(), "Se esperaba 'let' o 'const' en for..of");
    const bindingKeyword = this.previous();
    const mutable = bindingKeyword.kind === "let";
    const name = this.consume("identifier", "Se esperaba el nombre de la variable en for..of");
    let declaredType: TypeName | undefined;
    if (this.match(":")) declaredType = this.typeName();
    this.consume("of", "Se esperaba 'of' en for..of");
    const iterable = this.expression();
    this.consume(")", "Se esperaba ')' después del iterable de for..of");
    const body = this.statement();
    // `binding` requiere un `initializer` por la forma de `VariableDeclaration`;
    // el caso `ForOfStatement` del type-checker lo ignora y registra el símbolo
    // con el tipo del elemento.
    const syntheticInit: Expression = { kind: "LiteralExpression", value: 0, literalType: "void", span: name.span };
    const binding: import("../ast/nodes.ts").VariableDeclaration = {
      kind: "VariableDeclaration", mutable, name: name.lexeme, declaredType, initializer: syntheticInit,
      span: span(bindingKeyword.span.start, name.span.end),
    };
    return { kind: "ForOfStatement", binding, iterable, await: !!awaited, body, span: span(keyword.span.start, body.span.end) };
  }

  private forInStatement(keyword: Token): Statement {
    // Patrón: `for ( let|const IDENT [ : TYPE ] in EXPR ) STMT`
    if (!this.match("let", "const")) this.error(this.peek(), "Se esperaba 'let' o 'const' en for..in");
    const bindingKeyword = this.previous();
    const mutable = bindingKeyword.kind === "let";
    const name = this.consume("identifier", "Se esperaba el nombre de la variable en for..in");
    let declaredType: TypeName | undefined;
    if (this.match(":")) declaredType = this.typeName();
    this.consume("in", "Se esperaba 'in' en for..in");
    const target = this.expression();
    this.consume(")", "Se esperaba ')' después del objetivo de for..in");
    const body = this.statement();
    const syntheticInit: Expression = { kind: "LiteralExpression", value: 0, literalType: "void", span: name.span };
    const binding: import("../ast/nodes.ts").VariableDeclaration = {
      kind: "VariableDeclaration", mutable, name: name.lexeme, declaredType, initializer: syntheticInit,
      span: span(bindingKeyword.span.start, name.span.end),
    };
    return { kind: "ForInStatement", binding, target, body, span: span(keyword.span.start, body.span.end) };
  }

  // Avanza el cursor de tokens sin consumir nada y devuelve el identificador
  // `of` o `in` que delimita un `for..of` / `for..in` dentro del paréntesis
  // abierto por el dispatcher; respeta el anidamiento de paréntesis y devuelve
  // `null` si encuentra un `;` (for clásico) o el `)` de cierre sin hallarlos.
  private lookAheadForOfOrIn(): "of" | "in" | null {
    let depth = 1;
    let offset = 0;
    while (depth > 0) {
      const tok = this.peekAt(offset);
      if (tok.kind === "eof") return null;
      if (tok.kind === "(") depth++;
      else if (tok.kind === ")") {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1) {
        if (tok.kind === ";") return null;
        if (tok.kind === "of") return "of";
        if (tok.kind === "in") return "in";
      }
      offset++;
    }
    return null;
  }

  private returnStatement(keyword: Token): Statement {
    const value = this.check(";") ? undefined : this.expression();
    const end = this.consumeStatementTerminator("Se esperaba ';' después de return");
    return { kind: "ReturnStatement", value, span: span(keyword.span.start, end.span.end) };
  }

  private block(open: Token): BlockStatement {
    const statements: Statement[] = [];
    while (!this.check("}") && !this.check("eof")) {
      this.skipNewlines();
      if (this.check("}") || this.check("eof")) break;
      statements.push(this.statement());
    }
    const close = this.consume("}", "Se esperaba '}'");
    return { kind: "BlockStatement", statements, span: span(open.span.start, close.span.end) };
  }

  private expression(): Expression {
    // V23: lookahead para distinguir `match(v, [...])` (intrinsics) de
    // `match(v) {...}` (V2 keyword). `match` ya no es keyword (lo
    // convertimos en identifier para soportar la nueva sintaxis), así que
    // tenemos que mirar el lexema del token actual.
    if (this.check("identifier") && this.peek().lexeme === "match") {
      const afterParen = this.lookaheadAfterMatchParen();
      if (afterParen === "new") {
        // match(value, [...]) o match(value, "key", [...])
        return this.assignment();
      }
      return this.matchExpression();
    }
    const left = this.isArrowStart() ? this.arrowFunction() : this.assignment();
    return this.ternary(left);
  }

  /**
   * V23: mira lo que hay justo después del `(` en `match (`. Devuelve:
   *   - "new" si lo siguiente es `,` o un literal (nueva forma intrinsics).
   *   - "keyword" si lo siguiente es `{`, `)`, o cualquier otra cosa (V2).
   */
  private lookaheadAfterMatchParen(): "new" | "keyword" {
    const start = this.current;
    // Como `match` ya es identifier, buscamos por lexema.
    if (this.tokens[start].lexeme !== "match") return "keyword";
    if (this.tokens[start + 1]?.kind !== "(") return "keyword";
    let depth = 1;
    for (let i = start + 2; i < this.tokens.length; i++) {
      const k = this.tokens[i].kind;
      if (k === "(") depth++;
      else if (k === ")") {
        depth--;
        if (depth === 0) return "keyword";
        continue;
      }
      if (depth === 1 && k === ",") return "new";
      if (depth === 1 && k === "{") return "keyword";
    }
    return "keyword";
  }

  /**
   * Parsea arms de `match` V2 (destructured sobre tagged unions).
   *   - `case { kind: "<Variant>", <id>?, ... }: <expr>;`
   *   - `case _: <expr>;`
   *
   * La forma TC39 `when (p) => <expr>;` se eliminó en V23. Si el parser
   * encuentra `when` aquí, emite diagnóstico E4400 sugiriendo la nueva
   * sintaxis `match(v, [when(p, () => <expr>)])`.
   *
   * V23: los `match` keyword (V2 destructurado) y `match(v, [...])` (V23
   * intrinsics) son formas distintas. El keyword exige `match (subject) { ... }`
   * con `{` literal; la V23 usa `match(subject, [...])` sin llaves y se
   * parsea como `CallExpression` normal.
   */
  private matchArms(arms: MatchArm[]): void {
    while (!this.check("}") && !this.check("eof")) {
      // Saltamos newlines y comas entre arms (separadores en la forma
      // `Type.Variant(x) => expr,` del tutorial §9, y tambien en la forma
      // V2 `case { kind: ... }: expr;` con newline significativo).
      this.skipNewlines();
      this.match(",");
      this.skipNewlines();
      if (this.check("}") || this.check("eof")) break;
      if (this.check("case")) {
        this.advance(); // consume 'case'
        const arm = this.parseCaseArm();
        arms.push(arm);
      } else if (this.check("when")) {
        // V23: la sintaxis TC39 `when (p) => ...` se eliminó. Diagnosticamos
        // y dejamos que el caller siga parseando para encontrar el `}`.
        this.advance(); // consume 'when'
        this.error(this.previous(), "E4400: 'when (p) => ...' dentro de 'match' ya no se admite; usa 'match(value, [when(p, () => result)])' en su lugar");
        // Skip hasta el siguiente `;` o `}` para no liar el resto del bloque.
        let parenDepth = 0;
        while (!this.check("eof")) {
          if (this.check("(")) parenDepth++;
          else if (this.check(")")) parenDepth--;
          else if (parenDepth === 0 && (this.check(";") || this.check("}"))) break;
          this.advance();
        }
        if (this.check(";")) this.advance();
      } else if (this.check("identifier")) {
        // Azucar: `Type.Variant(bindings) => <expr>,` o `Variant(bindings) => <expr>,`
        // (sin `case` ni `:`). Equivale a `case { kind: "<Variant>", ... }: <expr>;`
        // y es la forma que muestra el tutorial §9. La coma o salto de linea
        // actua como separador entre arms (no hace falta ';' ni ':').
        // `parseCaseArm` ya consume el terminator (newline o ';' o ',')
        // al final, asi que no hacemos nada extra aqui.
        const arm = this.parseCaseArm();
        arms.push(arm);
      } else {
        this.error(this.peek(), "Se esperaba 'case' o un patron de arm (e.g. Type.Variant(bindings)) para iniciar un arm de 'match'");
        return;
      }
    }
  }
  private parseCaseArm(): MatchArm {
    const start = this.peek().span.start;
    // Wildcard: `case _: ...;`
    if (this.check("identifier") && this.peek().lexeme === "_") {
      this.advance();
      this.consume(":", "Se esperaba ':' después del pattern de 'case'");
      const result = this.expression();
      const end = this.consumeStatementTerminator("Se esperaba ';' después del arm de 'match'");
      return {
        pattern: { kind: "IdentifierExpression", name: "_", span: span(start, end.span.start) },
        result,
        variantMatch: { variantName: "", bindings: [], isWildcard: true },
        span: span(start, end.span.end),
      };
    }
    // Azucar: `case Type.Variant(binding1, ...) => <expr>;` o
    //         `case Variant(binding1, ...) => <expr>;` (sin prefijo).
    // Equivale a `case { kind: "<VariantName>", binding1, ... }: <expr>;`.
    // Esto es lo que muestra el tutorial §9. Soporta tanto unions
    // (`union X = Foo | Bar`) como constructores de `Result` y otras
    // clases con factories estaticos.
    if (this.check("identifier") && this.checkNextIsMemberCallOrArrow()) {
      const unionOrType = this.advance();
      // Hay dos formas: `Name.Variant(...)` o `Name.Variant`. Si lo
      // siguiente es `.`, es la forma con tipo; si es `(`, es la forma
      // corta con solo el nombre de la variante.
      let variantName: string;
      if (this.match(".")) {
        const variantTok = this.consume("identifier", "Se esperaba el nombre de la variante tras '.'");
        variantName = variantTok.lexeme;
      } else {
        variantName = unionOrType.lexeme;
      }
      // Bindings: cero o mas identifiers separados por `,` dentro de `()`.
      const bindings: string[] = [];
      if (this.match("(")) {
        if (!this.check(")")) {
          do {
            const id = this.consume("identifier", "Se esperaba un identifier como binding");
            bindings.push(id.lexeme);
          } while (this.match(","));
        }
        this.consume(")", "Se esperaba ')' cerrando los bindings del arm de match");
      }
      // Ahora esperamos `=> <expr>;`
      this.consume("=>", "Se esperaba '=>' en el arm de 'match' estilo Result.ok(v) => ...");
      const result = this.expression();
      const end = this.consumeStatementTerminator("Se esperaba ';' o salto de linea despues del arm de 'match'");
      return {
        pattern: { kind: "IdentifierExpression", name: variantName, span: span(start, end.span.start) },
        result,
        variantMatch: { variantName, bindings },
        span: span(start, end.span.end),
      };
    }
    // Pattern destructuring: `case { kind: "<Variant>", <id>, ... }: ...;`
    this.consume("{", "Se esperaba '{' para iniciar el pattern de 'case'");
    let variantName = "";
    const bindings: string[] = [];
    // Primer campo obligatorio: `kind: "VariantName"`.
    this.consume("identifier", "Se esperaba 'kind' como primer campo del pattern");
    if (this.previous().lexeme !== "kind") this.error(this.previous(), "Se esperaba 'kind' como primer campo del pattern de 'case'");
    this.consume(":", "Se esperaba ':' después de 'kind'");
    const variantTok = this.consume("string", "El campo 'kind' de un pattern debe ser un literal de cadena");
    variantName = variantTok.lexeme;
    // Campos adicionales opcionales: cada uno es un identifier → binding.
    while (this.match(",")) {
      const id = this.consume("identifier", "Se esperaba un identifier como binding");
      bindings.push(id.lexeme);
    }
    this.consume("}", "Se esperaba '}' para cerrar el pattern de 'case'");
    this.consume(":", "Se esperaba ':' después del pattern de 'case'");
    const result = this.expression();
    const end = this.consumeStatementTerminator("Se esperaba ';' después del arm de 'match'");
    return {
      pattern: { kind: "IdentifierExpression", name: variantName, span: span(start, this.peek().span.start) },
      result,
      variantMatch: { variantName, bindings },
      span: span(start, end.span.end),
    };
  }
  // Helper: el token actual es un identifier y el siguiente NO es uno
  // de los que indican statement normal (no es inicio de un arm de match
  // estilo `Type.Variant(...) =>`).
  private checkNextIsMemberCallOrArrow(): boolean {
    // Despues del identifier debe venir `.`, `(`, o `=>`. Si viene
    // cualquier otra cosa, es un statement normal (e.g. `case foo;` no
    // es valido, pero el caller no nos llamaria aqui si el peek fuera
    // `;`).
    const next = this.peekAt(1);
    return next?.kind === "." || next?.kind === "=>";
  }
  private matchExpression(): MatchExpression {
    const keyword = this.previous();
    const start = this.peek().span.start;
    // V23: `match` ya no es keyword — es un identifier que el lookahead
    // detectó que va seguido de `(...) {`. Consumimos el identifier manualmente.
    if (this.check("identifier") && this.peek().lexeme === "match") this.advance();
    else this.error(this.peek(), "Se esperaba 'match' para iniciar una expresión match V2");
    this.consume("(", "Se esperaba '(' después de 'match'");
    const subject = this.expression();
    this.consume(")", "Se esperaba ')' después del sujeto de 'match'");
    this.consume("{", "Se esperaba '{' para los arms de 'match'");
    // Saltamos newlines tras el '{' por si el primer arm empieza en
    // la siguiente linea.
    this.skipNewlines();
    const arms: MatchArm[] = [];
    this.matchArms(arms);
    this.consume("}", "Se esperaba '}' al final de 'match'");
    return { kind: "MatchExpression", subject, arms, span: span(keyword.span.start, this.peek().span.start) };
  }
  // `cond ? then : else`. La condición se parsea por `assignment()`, lo que
  // excluye el `?:` de la derecha (right-associative). Si no hay `:`, devuelve
  // la expresión sin envolver.
  private ternary(condition: Expression): Expression {
    if (!this.match("?")) return condition;
    const thenBranch = this.expression();
    if (!thenBranch) { this.error(this.previous(), "Se esperaba una expresión después de '?'"); return condition; }
    if (!this.match(":")) {
      this.error(this.previous(), "Se esperaba ':' en el operador ternario");
      return condition;
    }
    const elseBranch = this.expression();
    if (!elseBranch) { this.error(this.previous(), "Se esperaba una expresión después de ':'"); return condition; }
    return { kind: "TernaryExpression", condition, thenBranch, elseBranch, span: span(condition.span.start, elseBranch.span.end) };
  }
  private arrowFunction(): Expression {
    const open = this.consume("(", "Se esperaba '('");
    const params: Parameter[] = [];
    if (!this.check(")")) do {
      // V22: `mut` eliminado.
      if (this.match("mut")) this.error(this.previous(), "E4400: 'mut' has been removed. Use ref<T> for an explicit mutable reference, or constRef<T> for a readonly borrow.");
      const name = this.consume("identifier", "Se esperaba el nombre del parámetro");
      this.consume(":", "Los parámetros de una función flecha necesitan tipo");
      const type = this.typeName();
      const defaultValue = this.match("=") ? this.expression() : undefined;
      params.push({ name: name.lexeme, type, out: false, passing: "value", defaultValue, span: name.span });
    } while (this.match(","));
    this.consume(")", "Se esperaba ')' después de los parámetros");
    const returnType = this.match(":") ? this.typeName() : undefined;
    this.consume("=>", "Se esperaba '=>' en la función flecha");
    if (this.match("{")) {
      const body = this.block(this.previous());
      return { kind: "ArrowFunctionExpression", params, returnType, body, span: span(open.span.start, body.span.end) };
    }
    const body = this.expression();
    return { kind: "ArrowFunctionExpression", params, returnType, body, span: span(open.span.start, body.span.end) };
  }
  private isArrowStart(): boolean {
    if (!this.check("(")) return false;
    let depth = 0; let index = this.current;
    for (; index < this.tokens.length; index++) {
      if (this.tokens[index].kind === "(") depth++;
      else if (this.tokens[index].kind === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return false;
    if (this.tokens[index + 1]?.kind === "=>") return true;
    if (this.tokens[index + 1]?.kind !== ":") return false;
    return this.tokens.slice(index + 2).some(token => token.kind === "=>");
  }
  private assignment(): Expression {
    const left = this.binary(1);
    if (!this.match("=")) return left;
    const value = this.assignment();
    if (left.kind !== "IdentifierExpression" && left.kind !== "MemberExpression" && left.kind !== "IndexExpression") this.error(this.previous(), "El lado izquierdo de una asignación debe ser una variable, campo o índice");
    return { kind: "AssignmentExpression", target: left as Extract<Expression, { kind: "IdentifierExpression" | "MemberExpression" | "IndexExpression" }>, value, span: span(left.span.start, value.span.end) };
  }
  private binary(min: number): Expression {
    let left = this.unary();
    while ((PRECEDENCE[this.peek().kind] ?? 0) >= min) {
      const op = this.advance(); const precedence = PRECEDENCE[op.kind] ?? 0;
      // `instanceof` toma un tipo a la derecha (`v instanceof string`), no una
      // expresión. El lexer marca los primitivos como `type`, no como
      // `identifier`, así que `binary(precedence + 1)` fallaría. Parseamos
      // el operando derecho como tipo y lo envolvemos en un IdentifierExpression
      // para que el type-checker lo vea como un nombre de tipo.
      let right: Expression;
      if (op.kind === "instanceof") {
        const typeName = this.typeName();
        right = { kind: "IdentifierExpression", name: typeName, span: op.span };
      } else {
        right = this.binary(precedence + 1);
      }
      left = { kind: "BinaryExpression", operator: op.lexeme, left, right, span: span(left.span.start, right.span.end) };
    }
    return left;
  }
  private unary(): Expression {
    if (this.match("await")) { const keyword = this.previous(); const operand = this.unary(); return { kind: "AwaitExpression", operand, span: span(keyword.span.start, operand.span.end) }; }
    if (this.match("typeof")) { const op = this.previous(); const operand = this.unary(); return { kind: "UnaryExpression", operator: "typeof", operand, span: span(op.span.start, operand.span.end) }; }
    if (this.match("!", "-", "+")) { const op = this.previous(); const operand = this.unary(); return { kind: "UnaryExpression", operator: op.lexeme as "!" | "-" | "+", operand, span: span(op.span.start, operand.span.end) }; }
    const operand = this.call();
    // `expr satisfies T` verifica que expr sea asignable a T. En el dialecto
    // el tipo de la expresión es siempre T (no preserva el inferido porque
    // no hay distinción inferido/declarado). Sintácticamente se permite
    // solo después de un call (postfix).
    if (this.match("satisfies")) {
      const declaredType = this.typeName();
      return { kind: "SatisfiesExpression", operand, declaredType, span: span(operand.span.start, this.peek().span.start) };
    }
    return operand;
  }
  private call(): Expression {
    let expr = this.primary();
    for (;;) {
      if (this.match("(")) {
        const open = this.previous(); const args: Expression[] = [];
        if (!this.check(")")) do { args.push(this.expression()); } while (this.match(","));
        const close = this.consume(")", "Se esperaba ')' después de los argumentos");
        if (expr.kind !== "IdentifierExpression") this.error(open, "Solo se pueden invocar funciones por nombre");
        expr = { kind: "CallExpression", callee: expr.kind === "IdentifierExpression" ? expr.name : "<error>", typeArguments: [], args, span: span(expr.span.start, close.span.end) };
      } else if (expr.kind === "IdentifierExpression" && this.isGenericCall()) {
        this.consume("<", "Se esperaba '<'"); const typeArguments: TypeName[] = [];
        do { typeArguments.push(this.typeName()); } while (this.match(","));
        this.consume(">", "Se esperaba '>'"); this.consume("(", "Se esperaba '('");
        const args: Expression[] = [];
        if (!this.check(")")) do { args.push(this.expression()); } while (this.match(","));
        const close = this.consume(")", "Se esperaba ')' después de los argumentos");
        expr = { kind: "CallExpression", callee: expr.name, typeArguments, args, span: span(expr.span.start, close.span.end) };
      } else if (expr.kind === "IdentifierExpression" && this.isGenericInstance()) {
        // V1.2: `Name<T1, T2>.Member(...)` — typeArguments del identificador
        // antes del member access. Modelamos el resultado como
        // MemberCallExpression sobre un GenericIdentifier.
        this.consume("<", "Se esperaba '<'");
        const typeArguments: TypeName[] = [];
        do { typeArguments.push(this.typeName()); } while (this.match(","));
        this.consume(">", "Se esperaba '>'");
        expr = { kind: "GenericIdentifierExpression", name: expr.name, typeArguments, span: expr.span };
        // Reentrar el bucle para procesar el `.` siguiente (si lo hay).
        continue;
      } else if (this.match(".", "?.")) {
        // `?.` marca el MemberExpression como `optional`. El type-checker
        // valida que el objeto sea `Optional<X>`; el codegen lo desazucara
        // a `optionalAndThen(obj, e => optionalSome(e.member))`.
        const isOptional = this.previous().kind === "?.";
        // Aceptamos `delete` como nombre de miembro (Map/Set.delete, etc.).
        // La keyword `delete` también se usa como statement (`delete map[k];`)
        // y se desambigua en el dispatcher de `statement()` antes de llegar
        // aquí: ese path consume `delete` y luego exige un `IndexExpression`,
        // nunca `member_access`. Por tanto, en contexto de miembro `delete`
        // es siempre un nombre de método.
        const member = this.check("delete") ? this.advance() : this.consume("identifier", "Se esperaba el nombre del miembro");
        const typeArguments: TypeName[] = [];
        if (this.match("<")) {
          do { typeArguments.push(this.typeName()); } while (this.match(","));
          this.consume(">", "Se esperaba '>' después de los argumentos de tipo del método");
        }
        if (this.match("(")) {
          const args: Expression[] = [];
          if (!this.check(")")) do { args.push(this.expression()); } while (this.match(","));
          const close = this.consume(")", "Se esperaba ')' después de los argumentos");
          expr = { kind: "MemberCallExpression", object: expr, method: member.lexeme, typeArguments, args, optional: isOptional, span: span(expr.span.start, close.span.end) };
        } else {
          if (typeArguments.length) this.error(member, "Los argumentos de tipo de un método requieren una llamada");
          expr = { kind: "MemberExpression", object: expr, member: member.lexeme, optional: isOptional, span: span(expr.span.start, member.span.end) };
        }
      } else if (this.match("[")) {
        const index = this.expression();
        const close = this.consume("]", "Se esperaba ']' después del índice");
        expr = { kind: "IndexExpression", object: expr, index, span: span(expr.span.start, close.span.end) };
      } else break;
    }
    return expr;
  }
  private primary(): Expression {
    const token = this.advance();
    if (token.kind === "template") return this.templateLiteral(token);
    if (token.kind === "new") {
      const classToken = this.consume("identifier", "Se esperaba el nombre de la clase");
      let className: TypeName = classToken.lexeme;
      if (this.match("<")) {
        const arguments_: TypeName[] = [];
        do { arguments_.push(this.typeName()); } while (this.match(","));
        this.consume(">", "Se esperaba '>' en la clase genérica");
        className = genericType(className, arguments_);
      }
      this.consume("(", "Se esperaba '(' después de la clase");
      const args: Expression[] = [];
      if (!this.check(")")) do { args.push(this.expression()); } while (this.match(","));
      const close = this.consume(")", "Se esperaba ')' después de los argumentos");
      return { kind: "NewExpression", className, args, span: span(token.span.start, close.span.end) };
    }
    if (token.kind === "[") {
      const elements: ArrayElement[] = [];
      if (!this.check("]")) {
        do {
          if (this.match("...")) {
            const expr = this.expression();
            elements.push({ kind: "SpreadElement", expression: expr, span: expr.span });
          } else {
            elements.push(this.expression());
          }
        } while (this.match(",") && !this.check("]"));
      }
      const close = this.consume("]", "Se esperaba ']' después del literal");
      return { kind: "ArrayLiteralExpression", elements, span: span(token.span.start, close.span.end) };
    }
    // V1.4: object literal `{ ok: true, value: x, error: "..." }` se usa
    // como constructor inline de una object-variant. Cada propiedad es
    // un par `field: value`; el primer campo debe ser el discriminador
    // (literal primitivo). El type-checker conecta el literal con la
    // unión esperada en el contexto.
    if (token.kind === "{") {
      const properties: { key: string; value: Expression }[] = [];
      if (!this.check("}")) do {
        const keyTok = this.consume("identifier", "Se esperaba el nombre de la propiedad");
        this.consume(":", "Se esperaba ':' después del nombre de la propiedad");
        const value = this.expression();
        properties.push({ key: keyTok.lexeme, value });
      } while (this.match(","));
      const close = this.consume("}", "Se esperaba '}' para cerrar el object literal");
      return { kind: "ObjectLiteralExpression", properties, span: span(token.span.start, close.span.end) };
    }
    if (token.kind === "number") return { kind: "LiteralExpression", value: Number(token.lexeme.replace(/_/g, "")), literalType: "number", raw: token.lexeme, span: token.span };
    if (token.kind === "string") return { kind: "LiteralExpression", value: token.lexeme, literalType: "string", span: token.span };
    if (token.kind === "true" || token.kind === "false") return { kind: "LiteralExpression", value: token.kind === "true", literalType: "boolean", span: token.span };
    if (token.kind === "identifier") return { kind: "IdentifierExpression", name: token.lexeme, span: token.span };
    if (token.kind === "(") { const expr = this.expression(); this.consume(")", "Se esperaba ')'"); return expr; }
    this.error(token, "Se esperaba una expresión");
    return { kind: "LiteralExpression", value: 0, literalType: "number", span: token.span };
  }

  private typeName(): TypeName {
    // V5: prefijo `readonly` en posición de tipo (p.ej. `let x: readonly T[] = ...`).
    // Distinguimos por contexto: dentro de ClassField el `readonly` ya se consumió
    // como modificador del nombre del campo; aquí lo vemos solo cuando aparece
    // después de `:` o en una expresión de tipo (`as readonly T`). Decoramos el
    // tipo resultante con `readonlyType(inner)`.
    if (this.match("readonly")) {
      const inner = this.typeName();
      return readonlyType(inner);
    }
    // `typeof` en posición de tipo: identificador contextual que resuelve al
    // tipo estático del símbolo nombrado. Se trata antes del caso genérico
    // para que `typeof x` no se confunda con un nombre de tipo normal.
    if (this.match("typeof")) {
      const name = this.consume("identifier", "typeof en posición de tipo requiere un identificador").lexeme;
      return typeofType(name);
    }
    if (this.match("(")) {
      const parameters: TypeName[] = [];
      if (!this.check(")")) do {
        this.consume("identifier", "El tipo de función necesita nombres de parámetros");
        this.consume(":", "Se esperaba ':' en el parámetro del tipo de función");
        parameters.push(this.typeName());
      } while (this.match(","));
      this.consume(")", "Se esperaba ')' en el tipo de función");
      this.consume("=>", "Se esperaba '=>' en el tipo de función");
      return functionType(parameters, this.typeName());
    }
    if (this.match("[")) {
      const elements: TypeName[] = [];
      if (!this.check("]")) do { elements.push(this.typeName()); } while (this.match(","));
      this.consume("]", "Se esperaba ']' en el tipo tupla");
      return tupleType(elements);
    }
    let result: TypeName;
    if (this.check("identifier")) result = this.advance().lexeme;
    else result = this.consume("type", "Se esperaba un tipo primitivo, clase, interfaz, array o tupla").lexeme;
    if (this.match("<")) {
      const arguments_: TypeName[] = [];
      do { arguments_.push(this.typeName()); } while (this.match(","));
      this.consume(">", "Se esperaba '>' en el tipo genérico");
      result = genericType(result, arguments_);
    }
    // V4: sufijos de array. Distinguimos `[N]` (tamaño literal entero, fijo,
    // pila) de `[]` (vector dinámico, heap). El canónico es T[N] para fijo
    // y T[] para vector; los helpers isFixedArrayType/fixedArrayElement/
    // fixedArraySize de type-system.ts permiten operar sin parsear strings.
    while (this.match("[")) {
      if (this.match("]")) {
        // T[]: array dinámico (heap, std::vector). El `]` ya se consumió en
        // el `match`, así que no hace falta consumirlo otra vez.
        result = arrayType(result);
      } else {
        // T[N]: array de tamaño fijo (pila, std::array). N puede ser literal
        // entero (`u8[4]`) o identifier (`u8[N]`, donde N es una constante
        // propagada en el type-checker; V6).
        if (this.check("number")) {
          const tok = this.advance();
          this.consume("]", "Se esperaba ']' cerrando el array fijo");
          result = `${result}[${Number(tok.lexeme)}]`;
        } else if (this.check("identifier")) {
          const tok = this.advance();
          this.consume("]", "Se esperaba ']' cerrando el array fijo");
          result = `${result}[${tok.lexeme}]`;
        } else {
          const tok = this.peek();
          this.error(tok, "Se esperaba un literal entero o identificador como tamaño del array fijo");
        }
      }
    }
    // Sufijo de union: `A | B | C`. Se compone con la sintaxis existente
    // (arrays, generics, tuplas, funciones) ya parseada.
    while (this.match("|")) result = `${result} | ${this.typeName()}`;
    // Sufijo de intersección: `A & B` (combina capacidades, típicas interfaces).
    while (this.match("&")) result = `${result} & ${this.typeName()}`;
    return result;
  }
  private typeParameterNames(): { parameters: TypeParameter[]; variadic: string[] } {
    const parameters: TypeParameter[] = [];
    const variadic: string[] = [];
    if (!this.match("<")) return { parameters, variadic };
    do {
      const isVariadic = this.match("...");
      const nameTok = this.consume("identifier", "Se esperaba un parámetro de tipo");
      const param: TypeParameter = { name: nameTok.lexeme, span: nameTok.span };
      if (isVariadic) variadic.push(nameTok.lexeme);
      if (this.match("extends")) param.constraint = this.typeName();
      if (this.match("=")) param.default = this.typeName();
      parameters.push(param);
    } while (this.match(","));
    this.consume(">", "Se esperaba '>' después de los parámetros de tipo");
    return { parameters, variadic };
  }
  // Convierte el lexema crudo de un `template` token en partes literales y
  // expresiones AST, reusando el lexer+parser para cada `${...}`.
  private templateLiteral(token: Token): TemplateLiteralExpression {
    const parts: string[] = [];
    const expressions: Expression[] = [];
    let buffer = "";
    let depth = 0;
    let exprStart = -1;
    for (let i = 0; i < token.lexeme.length; i++) {
      const c = token.lexeme[i];
      if (depth === 0 && c === "$" && token.lexeme[i + 1] === "{") {
        parts.push(buffer);
        buffer = "";
        depth++;
        i++;
        exprStart = i + 1;
        continue;
      }
      if (c === "{") { depth++; buffer += c; continue; }
      if (c === "}") {
        depth--;
        if (depth === 0) {
          const exprText = token.lexeme.slice(exprStart, i);
          expressions.push(this.parseSubexpression(exprText));
          exprStart = -1;
          // Resetear el buffer: las letras que cayeron como `buffer += c`
          // mientras `depth > 0` son el texto de la expresión y NO deben
          // mezclarse con la siguiente parte literal.
          buffer = "";
          continue;
        }
        buffer += c;
        continue;
      }
      buffer += c;
    }
    parts.push(buffer);
    return { kind: "TemplateLiteralExpression", parts, expressions, span: token.span };
  }
  private parseSubexpression(source: string): Expression {
    const subLexer = new Lexer(source);
    const subTokens = subLexer.tokenize();
    const subParser = new Parser(subTokens);
    return subParser.expression();
  }
  private isGenericCall(): boolean { return this.isGenericFollowedBy("("); }
  // V1.2: igual que `isGenericCall` pero acepta `.` después de `>`, para
  // soportar `Name<T>.Member(...)` (constructor de variante de unión).
  private isGenericInstance(): boolean { return this.isGenericFollowedBy(".") || this.isGenericFollowedBy("("); }
  private isGenericFollowedBy(follower: TokenKind): boolean {
    if (!this.check("<")) return false;
    let depth = 0;
    for (let index = this.current; index < this.tokens.length; index++) {
      if (this.tokens[index].kind === "<") depth++;
      else if (this.tokens[index].kind === ">") { depth--; if (depth === 0) return this.tokens[index + 1]?.kind === follower; }
      else if (this.tokens[index].kind === ";" || this.tokens[index].kind === "eof") return false;
    }
    return false;
  }
  // Salta cualquier cantidad de tokens 'newline' consecutivos. Se usa al
  // inicio de cada statement (incluido el primer statement del programa)
  // para que lineas en blanco o comentarios entre statements no
  // interrumpan el reconocimiento. La semantica de newline significativo
  // se aplica via consumeStatementTerminator() dentro de cada parser de
  // statement.
  private skipNewlines(): void {
    while (this.check("newline")) this.advance();
  }
  private consume(kind: TokenKind, message: string): Token { if (this.check(kind)) return this.advance(); this.error(this.peek(), message); return this.advance(); }
  // Consume el terminador de un statement. Acepta ';' (explicito), 'newline'
  // (significativo entre statements, equivalente a ;) o nada (cierre de
  // bloque }). Si no hay ninguno, emite un error indicando que se esperaba
  // un terminador. Retorna el token del delimitador (el ';' o 'newline'
  // consumido, o el peek si no consumio nada) para que el caller pueda
  // extender el span del AST node.
  //
  // Reglas:
  //  - Si el siguiente token es ';', lo consume y lo retorna.
  //  - Si es 'newline', lo consume y lo retorna (equivalente a ; opt-in).
  //  - Si es '}' o 'eof', no consume nada; retorna el peek.
  //  - En cualquier otro caso, emite un diagnostico y retorna el peek.
  //
  // Esto es opcional: si la entrada del usuario tiene el ';' explicito,
  // sigue funcionando exactamente igual.
  private consumeStatementTerminator(message: string): Token {
    if (this.check(";")) return this.advance();
    if (this.check("newline")) return this.advance();
    // En arms de match estilo `Type.Variant(x) => ...,` la coma o cierre
    // de `}` tambien actua como separador entre arms.
    if (this.check("}") || this.check("eof") || this.check(",")) return this.peek();
    this.error(this.peek(), message);
    return this.peek();
  }
  private error(token: Token, message: string): void { this.diagnostics.push({ phase: "parser", message, span: token.span }); }
  private match(...kinds: TokenKind[]): boolean { if (kinds.some(k => this.check(k))) { this.advance(); return true; } return false; }
  private check(kind: TokenKind): boolean { return this.peek().kind === kind; }
  private advance(): Token { if (!this.check("eof")) this.current++; return this.previous(); }
  private peek(): Token { return this.tokens[this.current]; }
  private peekAt(offset: number): Token { const index = this.current + offset; return this.tokens[index < this.tokens.length ? index : this.tokens.length - 1]; }
  private previous(): Token { return this.tokens[Math.max(0, this.current - 1)]; }
}
