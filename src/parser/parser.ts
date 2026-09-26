import type { Program, Statement, Expression, TypeName, BlockStatement, Parameter, InterfaceMethod, ClassField, ClassMethod, TemplateLiteralExpression, TypeParameter, TypeAliasDeclaration, EnumDeclaration, EnumMember, LiteralExpression } from "../ast/nodes.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { span } from "../core/span.ts";
import { Lexer } from "../lexer/lexer.ts";
import type { Token, TokenKind } from "../lexer/token.ts";
import { arrayType, functionType, genericType, tupleType, typeofType } from "../types/type-system.ts";

const PRECEDENCE: Partial<Record<TokenKind, number>> = { "??": 1, "||": 2, "&&": 3, "==": 4, "!=": 4, "<": 5, "<=": 5, ">": 5, ">=": 5, "instanceof": 5, "|": 6, "&": 6, "^": 6, "<<": 6, ">>": 6, "+": 7, "-": 7, "*": 8, "/": 8, "%": 8 };

export class Parser {
  private readonly tokens: Token[];
  private current = 0;
  private readonly diagnostics: Diagnostic[] = [];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  parseProgram(): Program {
    const statements: Statement[] = [];
    while (!this.check("eof")) statements.push(this.statement(true));
    if (this.diagnostics.length) throw new DiagnosticError(this.diagnostics);
    return { kind: "Program", statements, span: span(this.tokens[0].span.start, this.peek().span.end) };
  }

  private statement(topLevel = false): Statement {
    const exported = this.match("export");
    if (exported && !topLevel) this.error(this.previous(), "'export' solo es válido en el nivel superior de un módulo");
    if (this.match("let", "const")) return this.variable(this.previous(), exported);
    if (this.match("async")) {
      const keyword = this.previous();
      this.consume("function", "'async' solo puede preceder a una función");
      return this.functionDeclaration(keyword, true, exported);
    }
    if (this.match("function")) return this.functionDeclaration(this.previous(), false, exported);
    if (this.match("interface")) return this.interfaceDeclaration(this.previous(), exported);
    if (this.match("class")) return this.classDeclaration(this.previous(), exported);
    if (this.match("type")) return this.typeAliasDeclaration(this.previous(), exported);
    if (this.match("enum")) return this.enumDeclaration(this.previous(), exported);
    if (exported) this.error(this.peek(), "'export' debe preceder a let, const, function, async function, interface o class");
    if (this.match("if")) return this.ifStatement(this.previous());
    if (this.match("while")) return this.whileStatement(this.previous());
    if (this.match("for")) {
      const keyword = this.previous();
      this.consume("(", "Se esperaba '(' después de 'for'");
      // Detecta `for..of` / `for..in` mirando hacia adelante dentro del paréntesis:
      // la presencia de `of` / `in` como identifier a profundidad 1 distingue el
      // bucle estilo TypeScript del clásico `for(init; cond; incr)`.
      const kind = this.lookAheadForOfOrIn();
      if (kind === "of") return this.forOfStatement(keyword);
      if (kind === "in") return this.forInStatement(keyword);
      return this.forStatement(keyword);
    }
    if (this.match("break", "continue")) {
      const keyword = this.previous(); const end = this.consume(";", `Se esperaba ';' después de ${keyword.lexeme}`);
      return { kind: keyword.kind === "break" ? "BreakStatement" : "ContinueStatement", span: span(keyword.span.start, end.span.end) };
    }
    if (this.match("return")) return this.returnStatement(this.previous());
    if (this.match("{")) return this.block(this.previous());
    if (this.match("delete")) return this.deleteStatement(this.previous());
    const expr = this.expression();
    const end = this.consume(";", "Se esperaba ';' después de la expresión");
    return { kind: "ExpressionStatement", expression: expr, span: span(expr.span.start, end.span.end) };
  }

  private deleteStatement(keyword: Token): Statement {
    const target = this.expression();
    if (target.kind !== "IndexExpression") this.error(target.span, "delete requiere un acceso por índice (map[k], set[v], arr[i])");
    const end = this.consume(";", "Se esperaba ';' después de 'delete'");
    return { kind: "DeleteStatement", target: target as IndexExpression, span: span(keyword.span.start, end.span.end) };
  }

  private variable(keyword: Token, exported = false): Statement {
    // Destructuring de arrays: `const [a, b, c] = expr;`
    if (this.check("[")) {
      const open = this.advance();
      const bindings: { name: string; declaredType?: TypeName }[] = [];
      while (!this.check("]")) {
        const ident = this.consume("identifier", "Se esperaba un identificador en el patrón de destructuring");
        let declaredType: TypeName | undefined;
        if (this.match(":")) declaredType = this.typeName();
        bindings.push({ name: ident.lexeme, declaredType });
        if (!this.match(",")) break;
      }
      const close = this.consume("]", "Se esperaba ']' después del patrón de destructuring");
      let declaredType: TypeName | undefined;
      if (this.match(":")) declaredType = this.typeName();
      this.consume("=", "Toda variable debe tener un inicializador");
      const initializer = this.expression();
      const end = this.consume(";", "Se esperaba ';' después de la declaración");
      return { kind: "VariableDeclaration", exported, mutable: keyword.kind === "let", name: "", declaredType, initializer, arrayBindings: bindings, span: span(keyword.span.start, end.span.end) };
    }
    const name = this.consume("identifier", "Se esperaba el nombre de la variable");
    let declaredType: TypeName | undefined;
    if (this.match(":")) declaredType = this.typeName();
    this.consume("=", "Toda variable debe tener un inicializador");
    const initializer = this.expression();
    const end = this.consume(";", "Se esperaba ';' después de la declaración");
    return { kind: "VariableDeclaration", exported, mutable: keyword.kind === "let", name: name.lexeme, declaredType, initializer, span: span(keyword.span.start, end.span.end) };
  }

  private functionDeclaration(keyword: Token, isAsync: boolean, exported = false): Statement {
    const name = this.consume("identifier", "Se esperaba el nombre de la función");
    const generics = this.typeParameterNames();
    this.consume("(", "Se esperaba '('");
    const params: Parameter[] = [];
    if (!this.check(")")) do {
      const variadic = this.match("...");
      const out = this.match("out");
      const mutable = this.match("mut");
      if (out && mutable) this.error(this.previous(), "Un parámetro no puede ser out y mut a la vez");
      const p = this.consume("identifier", "Se esperaba el nombre del parámetro");
      this.consume(":", "El parámetro necesita un tipo");
      const type = this.typeName();
      const defaultValue = this.match("=") ? this.expression() : undefined;
      params.push({ name: p.lexeme, type, out, passing: out ? "out" : mutable ? "mut" : "automatic", variadic, defaultValue, span: p.span });
    } while (this.match(","));
    this.consume(")", "Se esperaba ')' después de los parámetros");
    this.consume(":", "La función necesita un tipo de retorno");
    const returnType = this.typeName();
    const open = this.consume("{", "Se esperaba el cuerpo de la función");
    const body = this.block(open);
    return { kind: "FunctionDeclaration", exported, name: name.lexeme, async: isAsync, typeParameters: generics.parameters, variadicTypeParameters: generics.variadic, params, returnType, body, span: span(keyword.span.start, body.span.end) };
  }

  private interfaceDeclaration(keyword: Token, exported = false): Statement {
    const name = this.consume("identifier", "Se esperaba el nombre de la interfaz");
    const open = this.consume("{", "Las interfaces son estructurales y no admiten herencia; se esperaba '{'");
    const methods: InterfaceMethod[] = [];
    while (!this.check("}") && !this.check("eof")) {
      const methodName = this.consume("identifier", "Se esperaba el nombre del método");
      this.consume("(", "Se esperaba '('");
      const params: Parameter[] = [];
      if (!this.check(")")) do {
        const out = this.match("out");
        const mutable = this.match("mut");
        if (out && mutable) this.error(this.previous(), "Un parámetro no puede ser out y mut a la vez");
        const parameter = this.consume("identifier", "Se esperaba el nombre del parámetro");
        this.consume(":", "El parámetro necesita un tipo");
        const type = this.typeName();
        const defaultValue = this.match("=") ? this.expression() : undefined;
        params.push({ name: parameter.lexeme, type, out, passing: out ? "out" : mutable ? "mut" : "automatic", defaultValue, span: parameter.span });
      } while (this.match(","));
      this.consume(")", "Se esperaba ')' después de los parámetros");
      this.consume(":", "El método necesita un tipo de retorno");
      const returnType = this.typeName();
      const end = this.consume(";", "Se esperaba ';' después del método");
      methods.push({ name: methodName.lexeme, params, returnType, span: span(methodName.span.start, end.span.end) });
    }
    const close = this.consume("}", "Se esperaba '}' después de la interfaz");
    return { kind: "InterfaceDeclaration", exported, name: name.lexeme, methods, span: span(keyword.span.start, close.span.end) };
  }

  private classDeclaration(keyword: Token, exported = false): Statement {
    const name = this.consume("identifier", "Se esperaba el nombre de la clase");
    const generics = this.typeParameterNames();
    this.consume("{", "Las clases no admiten herencia; se esperaba '{'");
    const fields: ClassField[] = [];
    const methods: ClassMethod[] = [];
    while (!this.check("}") && !this.check("eof")) {
      const readonly = this.match("readonly");
      const member = this.consume("identifier", "Se esperaba un campo o método");
      if (this.match(":")) {
        const type = this.typeName();
        const end = this.consume(";", "Se esperaba ';' después del campo");
        fields.push({ name: member.lexeme, type, readonly, span: span(member.span.start, end.span.end) });
      } else {
        const generics = this.typeParameterNames();
        this.consume("(", "Se esperaba '(' en el método");
        const params: Parameter[] = [];
        if (!this.check(")")) do {
          const out = this.match("out");
          const mutable = this.match("mut");
          if (out && mutable) this.error(this.previous(), "Un parámetro no puede ser out y mut a la vez");
          const parameter = this.consume("identifier", "Se esperaba el nombre del parámetro");
          this.consume(":", "El parámetro necesita un tipo");
          const type = this.typeName();
          const defaultValue = this.match("=") ? this.expression() : undefined;
          params.push({ name: parameter.lexeme, type, out, passing: out ? "out" : mutable ? "mut" : "automatic", defaultValue, span: parameter.span });
        } while (this.match(","));
        this.consume(")", "Se esperaba ')' después de los parámetros");
        // El método `constructor` es especial: no tiene tipo de retorno
        // explícito y siempre devuelve void. Lo detectamos por nombre; C++
        // también usa ese nombre, así que la traducción es directa.
        const isConstructor = member.lexeme === "constructor";
        const returnType: TypeName = isConstructor ? "void" : (this.match(":") ? this.typeName() : (this.error(this.peek(), "El método necesita un tipo de retorno"), "void"));
        const open = this.consume("{", "Se esperaba el cuerpo del método");
        const body = this.block(open);
        methods.push({ name: member.lexeme, typeParameters: generics.parameters, params, returnType, body, span: span(member.span.start, body.span.end) });
      }
    }
    const close = this.consume("}", "Se esperaba '}' después de la clase");
    return { kind: "ClassDeclaration", exported, name: name.lexeme, typeParameters: generics.parameters, variadicTypeParameters: generics.variadic, fields, methods, span: span(keyword.span.start, close.span.end) };
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
    const end = this.consume(";", "Se esperaba ';' después del alias de tipo");
    return { kind: "TypeAliasDeclaration", exported, name: name.lexeme, typeParameters, type, span: span(keyword.span.start, end.span.end) };
  }

  // `enum X { Member1, Member2 = expr, ... }`. Soporta enums numéricos (auto-incremento
  // desde 0, valores explícitos opcionales) y de cadena (todos los miembros deben tener
  // valor explícito). Se rechazan enums mixtos y valores computados.
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
      const expression = this.expression(); const end = this.consume(";", "Se esperaba ';' después del inicializador de for");
      initializer = { kind: "ExpressionStatement", expression, span: span(expression.span.start, end.span.end) };
    }
    const condition = this.check(";") ? undefined : this.expression();
    this.consume(";", "Se esperaba ';' después de la condición de for");
    const increment = this.check(")") ? undefined : this.expression();
    this.consume(")", "Se esperaba ')' después de for");
    const body = this.statement();
    return { kind: "ForStatement", initializer, condition, increment, body, span: span(keyword.span.start, body.span.end) };
  }

  private forOfStatement(keyword: Token): Statement {
    // Patrón: `for ( let|const IDENT [ : TYPE ] of EXPR ) STMT`
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
    return { kind: "ForOfStatement", binding, iterable, body, span: span(keyword.span.start, body.span.end) };
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
    const end = this.consume(";", "Se esperaba ';' después de return");
    return { kind: "ReturnStatement", value, span: span(keyword.span.start, end.span.end) };
  }

  private block(open: Token): BlockStatement {
    const statements: Statement[] = [];
    while (!this.check("}") && !this.check("eof")) statements.push(this.statement());
    const close = this.consume("}", "Se esperaba '}'");
    return { kind: "BlockStatement", statements, span: span(open.span.start, close.span.end) };
  }

  private expression(): Expression {
    const left = this.isArrowStart() ? this.arrowFunction() : this.assignment();
    return this.ternary(left);
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
      const mutable = this.match("mut");
      const name = this.consume("identifier", "Se esperaba el nombre del parámetro");
      this.consume(":", "Los parámetros de una función flecha necesitan tipo");
      const type = this.typeName();
      const defaultValue = this.match("=") ? this.expression() : undefined;
      params.push({ name: name.lexeme, type, out: false, passing: mutable ? "mut" : "automatic", defaultValue, span: name.span });
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
    return this.call();
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
      } else if (this.match(".")) {
        // Aceptamos `delete` como nombre de miembro (Map/Set.delete, etc.).
        // La keyword `delete` también se usa como statement (`delete map[k];`)
        // y se desambigua en el dispatcher de `statement()` antes de llegar
        // aquí: ese path consume `delete` y luego exige un `IndexExpression`,
        // nunca `member_access`. Por tanto, en contexto de miembro `delete`
        // es siempre un nombre de método.
        // Rechazamos `?.` (optional chaining): el dialecto no tiene `null` ni
        // `undefined` como valores normales; el único ausente es `void`/
        // `Result<T>`, que se modela con `Result.isOk()`. El azúcar de `?.`
        // no tendría semántica clara aquí.
        if (this.check("?")) {
          this.error(this.peek(), "Optional chaining '?.' no se admite: el dialecto no tiene null ni undefined");
          this.advance();
        }
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
          expr = { kind: "MemberCallExpression", object: expr, method: member.lexeme, typeArguments, args, span: span(expr.span.start, close.span.end) };
        } else {
          if (typeArguments.length) this.error(member, "Los argumentos de tipo de un método requieren una llamada");
          expr = { kind: "MemberExpression", object: expr, member: member.lexeme, span: span(expr.span.start, member.span.end) };
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
      const elements: Expression[] = [];
      if (!this.check("]")) do { elements.push(this.expression()); } while (this.match(","));
      const close = this.consume("]", "Se esperaba ']' después del literal");
      return { kind: "ArrayLiteralExpression", elements, span: span(token.span.start, close.span.end) };
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
    while (this.match("[")) { this.consume("]", "Se esperaba ']' en el tipo array"); result = arrayType(result); }
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
  private isGenericCall(): boolean {
    if (!this.check("<")) return false;
    let depth = 0;
    for (let index = this.current; index < this.tokens.length; index++) {
      if (this.tokens[index].kind === "<") depth++;
      else if (this.tokens[index].kind === ">") { depth--; if (depth === 0) return this.tokens[index + 1]?.kind === "("; }
      else if (this.tokens[index].kind === ";" || this.tokens[index].kind === "eof") return false;
    }
    return false;
  }
  private consume(kind: TokenKind, message: string): Token { if (this.check(kind)) return this.advance(); this.error(this.peek(), message); return this.advance(); }
  private error(token: Token, message: string): void { this.diagnostics.push({ phase: "parser", message, span: token.span }); }
  private match(...kinds: TokenKind[]): boolean { if (kinds.some(k => this.check(k))) { this.advance(); return true; } return false; }
  private check(kind: TokenKind): boolean { return this.peek().kind === kind; }
  private advance(): Token { if (!this.check("eof")) this.current++; return this.previous(); }
  private peek(): Token { return this.tokens[this.current]; }
  private peekAt(offset: number): Token { const index = this.current + offset; return this.tokens[index < this.tokens.length ? index : this.tokens.length - 1]; }
  private previous(): Token { return this.tokens[Math.max(0, this.current - 1)]; }
}
