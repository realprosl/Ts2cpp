import { Lexer } from "./lexer/lexer.ts";
import { Parser } from "./parser/parser.ts";
import { TypeChecker } from "./semantic/type-checker.ts";
import { CppGenerator } from "./codegen/cpp-generator.ts";
import { evaluateComptime, markComptimeOnlyFunctions } from "./codegen/comptime-evaluator.ts";
import type { Program, Statement, CallExpression, Expression } from "./ast/nodes.ts";

export interface CompilationResult { ast: Program; cpp: string }
/** V15: resultado del pipeline por módulos. El header contiene todas las
 * declaraciones que cualquier módulo puede necesitar (forward declarations
 * de clases, firmas de funciones exportadas, etc.). Cada entry de `modules`
 * es el `.cpp` que contiene SOLO el código de ese módulo (incluye el header). */
export interface ModuleCompilation {
  header: string;
  modules: { name: string; cpp: string }[];
}

export function parse(source: string): Program {
  return new Parser(new Lexer(source).tokenize()).parseProgram();
}

/** V30.48: procesa las llamadas a funciones @etsgen. Cada call site
 *  se evalúa estaticamente; el string retornado se parsea como código
 *  del dialecto, se compila a C++ y se inyecta como RawCppExpression.
 *
 *  @etsgen es más poderoso que @cppgen porque el codigo generado
 *  puede usar el dialecto completo (control flow, funciones, etc.),
 *  no solo C++ literal. El costo: hay que parsear y compilar el
 *  string, lo que puede ser lento si se hace en bucles grandes.
 *
 *  Por ahora, las funciones @etsgen se procesan en una pasada
 *  separada después de evaluateComptime (que solo procesa @comptime
 *  y @cppgen). Esto evita el ciclo de imports entre comptime-evaluator
 *  y parser. */
export function evalEtsgenCalls(program: Program): Program {
  // Paso 1: identificar las funciones @etsgen del programa.
  const etsgenFns = new Map<string, { body: Statement; params: string[]; span: { start: number; end: number } }>();
  for (const stmt of program.statements) {
    if (stmt.kind === "FunctionDeclaration" && stmt.decorators?.some((d) => d.name === "etsgen")) {
      etsgenFns.set(stmt.name, {
        body: stmt.body,
        params: stmt.params.map((p) => p.name),
        span: stmt.span,
      });
    }
  }
  if (etsgenFns.size === 0) return program;

  // Paso 2: implementar un mini-evaluador para los bodies de @etsgen.
  // Los args siempre son comptime-compatibles (el codegen los pone
  // como literales o identificadores). Si un arg no se puede evaluar,
  // dejamos el call site como esta para runtime.
  const evalBody = (fn: { body: Statement; params: string[] }, args: CallExpression["args"]): string | null => {
    // Solo soportamos bodies simples: un return string o una expression
    // statement que es un template literal / string concatenation.
    // Para empezar, implementamos solo el caso "return string".
    const returnStmt = (fn.body as { statements?: Statement[] }).statements?.[0];
    if (!returnStmt || returnStmt.kind !== "ReturnStatement" || !returnStmt.value) return null;
    // Evaluamos la expression con un scope que tiene los args como variables.
    const scope = new Map<string, unknown>();
    for (let i = 0; i < fn.params.length; i++) {
      const arg = args[i]!;
      // Solo aceptamos LiteralExpression o IdentifierExpression como args.
      // Para IdentifierExpression, NO tenemos scope (es comptime-time);
      // el usuario debe usar comptime() / @comptime functions para
      // computar el valor.
      if (arg.kind === "LiteralExpression" && typeof (arg as { value: unknown }).value === "string") {
        scope.set(fn.params[i]!, (arg as { value: string }).value);
      } else if (arg.kind === "LiteralExpression" && typeof (arg as { value: unknown }).value === "number") {
        scope.set(fn.params[i]!, (arg as { value: number }).value);
      } else {
        return null;  // arg no comptime-compatible
      }
    }
    // Evaluamos la expression de retorno.
    return evalSimpleExpr(returnStmt.value as Expression, scope);
  };

  // Mini-evaluador de expressions simples (string concat, template literals, etc.).
  // Esto es un subset del comptime-evaluator; solo lo necesario para @etsgen.
  const evalSimpleExpr = (expr: Expression, scope: Map<string, unknown>): string | null => {
    if (expr.kind === "LiteralExpression") {
      return String((expr as { value: unknown }).value);
    }
    if (expr.kind === "TemplateLiteralExpression") {
      const tpl = expr as { parts: string[]; expressions: Expression[] };
      let result = "";
      for (let i = 0; i < tpl.parts.length; i++) {
        result += tpl.parts[i]!;
        if (i < tpl.expressions.length) {
          const sub = evalSimpleExpr(tpl.expressions[i]!, scope);
          if (sub === null) return null;
          result += sub;
        }
      }
      return result;
    }
    if (expr.kind === "BinaryExpression" && (expr as { operator: string }).operator === "+") {
      const bin = expr as { left: Expression; right: Expression };
      const l = evalSimpleExpr(bin.left, scope);
      const r = evalSimpleExpr(bin.right, scope);
      if (l === null || r === null) return null;
      return l + r;
    }
    if (expr.kind === "IdentifierExpression") {
      const name = (expr as { name: string }).name;
      const v = scope.get(name);
      if (v === undefined) return null;
      return String(v);
    }
    if (expr.kind === "CallExpression") {
      // Permitimos llamadas a otras funciones @etsgen (con args comptime-compatibles).
      const c = expr as { callee: string; args: Expression[] };
      const fn = etsgenFns.get(c.callee);
      if (!fn) return null;
      return evalBody(fn, c.args);
    }
    return null;
  };

  // Paso 3: recorrer el AST y sustituir las calls a @etsgen por
  // RawCppExpression con el C++ generado.
  const visit = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(visit);
    const obj = node as Record<string, unknown>;
    // Sustituir la call si es a una @etsgen function.
    if (obj.kind === "CallExpression" && typeof obj.callee === "string" && etsgenFns.has(obj.callee)) {
      const call = obj as unknown as CallExpression;
      const fn = etsgenFns.get(call.callee)!;
      const etsCode = evalBody(fn, call.args);
      if (etsCode === null) {
        // Args no comptime-compatibles. Dejamos la call como esta
        // (se emitira como llamada runtime, pero @etsgen no se filtra
        // automaticamente — habria que añadirlo).
        return node;
      }
      // Compilamos el codigo del dialecto a C++. El codigo se
      // trata como un programa completo con una funcion main;
      // extraemos el body de ets_user_main al final.
      const wrappedCode = `function main(): void { ${etsCode} }`;
      const etsAst = parse(wrappedCode);
      const cpp = emitEtsAsCpp(etsAst);
      return { kind: "RawCppExpression", value: cpp, span: call.span };
    }
    // Recursión: visitar todos los campos.
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "parent" || k === "resolvedType") {
        result[k] = v;
      } else {
        result[k] = visit(v);
      }
    }
    return result;
  };
  return visit(program) as Program;
}

/** V30.48: mini-emit que convierte el AST de un codigo @etsgen a
 *  C++ ejecutable. Por simplicidad, solo maneja ExpressionStatement
 *  simples (asignaciones, llamadas a print, etc.). Para codigo mas
 *  complejo, el usuario deberia usar @cppgen con codigo C++ literal. */
function emitEtsAsCpp(program: Program): string {
  // El CppGenerator emite un cpp completo (header + main + init).
  // Para @etsgen solo queremos el codigo del main (sin header, sin init).
  // Usamos generateModule que emite un .cpp por modulo.
  const gen = new CppGenerator(
    () => ({ kind: "any" } as never),
    () => false,
    () => [],
    () => null,
    () => null,
  );
  try {
    const full = gen.generateModule(program, program, "ets_user_main", "ets_user_main_init", undefined);
    // Extraer el cuerpo de ets_user_main (entre { y } de la funcion).
    const match = full.match(/void ets_user_main\(\)\s*\{([\s\S]*?)\n\}/);
    if (match) {
      const body = match[1]!.split("\n").filter((l) => l.trim() && !l.trim().startsWith("// Generated")).join("\n");
      return body.trim();
    }
    return `/* etsgen: no se pudo extraer el codigo */`;
  } catch (e) {
    return `/* etsgen: error al compilar codigo generado: ${(e as Error).message} */`;
  }
}

export function analyze(programs: Program[]): { program: Program; checker: TypeChecker } {
  if (!programs.length) throw new Error("No hay módulos para analizar");
  const combined: Program = { kind: "Program", statements: programs.flatMap(module => module.statements), span: { start: programs[0].span.start, end: programs.at(-1)!.span.end } };
  // V30.41: comptime() — evaluar llamadas a comptime() ANTES del
  // type-checker. Asi el type-checker ve el valor literal (number,
  // string, etc.) en vez de la llamada, y la asignacion `let x: T =
  // comptime(...)` type-checka correctamente. Lo hacemos aqui (no en
  // compile) para que `compileFile` (que usa `analyze` directamente
  // para proyectos multi-archivo) tambien aplique comptime.
  // V30.48: despues de comptime, procesamos las calls a @etsgen.
  // Estas funciones generan codigo del dialecto (no C++ literal) que
  // se compila a C++ antes de inyectarse. Despues de evalEtsgenCalls,
  // las calls externas a @etsgen ya no existen (fueron sustituidas por
  // RawCppExpression), asi que markComptimeOnlyFunctions puede filtrar
  // las funciones @etsgen que solo se usaban estaticamente.
  const afterEtsgen = evalEtsgenCalls(evaluateComptime(combined));
  const program: Program = { ...afterEtsgen, statements: markComptimeOnlyFunctions(afterEtsgen.statements) };
  const checker = new TypeChecker();
  checker.check(program);
  return { program, checker };
}

export function compile(source: string): CompilationResult {
  const ast = parse(source);
  // V30.41: comptime() se evalua dentro de `analyze` para que
  // tanto el flujo `compile` como `compileFile` (multi-archivo)
  // lo apliquen en el mismo sitio. Devolvemos el AST del checker
  // (con comptime sustituido por literales) para que el codegen
  // no vea comptime calls.
  const { program, checker } = analyze([ast]);
  return { ast: program, cpp: new CppGenerator(expression => checker.typeOf(expression), expression => checker.isVariadic(expression), expression => checker.typeArgumentsOf(expression), name => checker.resolveTypeAliasFromAst(name), union => checker.resolveUnionAliasNameFromAst(union)).generate(program) };
}
