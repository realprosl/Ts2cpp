import { Lexer } from "./lexer/lexer.ts";
import { Parser } from "./parser/parser.ts";
import { TypeChecker } from "./semantic/type-checker.ts";
import { CppGenerator } from "./codegen/cpp-generator.ts";
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
  const program: Program = { kind: "Program", statements: programs.flatMap(module => module.statements), span: { start: programs[0].span.start, end: programs.at(-1)!.span.end } };
  const checker = new TypeChecker();
  checker.check(program);
  return { program, checker };
}

export function compile(source: string): CompilationResult {
  const ast = parse(source);
  const { checker } = analyze([ast]);
  return { ast, cpp: new CppGenerator(expression => checker.typeOf(expression), expression => checker.isVariadic(expression), expression => checker.typeArgumentsOf(expression)).generate(ast) };
}
