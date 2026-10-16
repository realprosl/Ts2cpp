import { Lexer } from "./lexer/lexer.ts";
import { Parser } from "./parser/parser.ts";
import { TypeChecker } from "./semantic/type-checker.ts";
import { CppGenerator } from "./codegen/cpp-generator.ts";
import { evaluateComptime } from "./codegen/comptime-evaluator.ts";
import type { Program } from "./ast/nodes.ts";

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

export function analyze(programs: Program[]): { program: Program; checker: TypeChecker } {
  if (!programs.length) throw new Error("No hay módulos para analizar");
  const combined: Program = { kind: "Program", statements: programs.flatMap(module => module.statements), span: { start: programs[0].span.start, end: programs.at(-1)!.span.end } };
  // V30.41: comptime() — evaluar llamadas a comptime() ANTES del
  // type-checker. Asi el type-checker ve el valor literal (number,
  // string, etc.) en vez de la llamada, y la asignacion `let x: T =
  // comptime(...)` type-checka correctamente. Lo hacemos aqui (no en
  // compile) para que `compileFile` (que usa `analyze` directamente
  // para proyectos multi-archivo) tambien aplique comptime.
  const program = evaluateComptime(combined);
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
