import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, resolve, basename } from "node:path";
import { parse, analyze } from "../compiler.ts";
import { CppGenerator } from "../codegen/cpp-generator.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { validateModuleVisibility } from "./module-visibility.ts";
import type { Program, Statement } from "../ast/nodes.ts";

const IMPORT_LINE = /^(\s*)import\s+(?:\{([^}]*)\}\s+from\s+)?["']([^"']+)["']\s*;\s*$/;

/** V15: nombre de init estable basado en el nombre del archivo. Si el
 * módulo cambia su contenido, el init mantiene el mismo nombre — así
 * `main.cpp` no se invalida cada vez que una dependencia cambia. */
function stableInitName(moduleFile: string): string {
  const base = basename(moduleFile).replace(/\.(ets|ts)$/, "").replace(/[^A-Za-z0-9_]/g, "_");
  return `ets_init_${base}`;
}

export interface ModuleCompilationResult {
  ast: import("../ast/nodes.ts").Program;
  header: string;
  modules: { name: string; cpp: string }[];
  moduleNames: string[];
}
export interface ModuleLoaderOptions { moduleRoots?: string[]; aliases?: Record<string, string>; minimal?: boolean }

export interface ModuleImport { names: string[]; dependency: string; line: number }
export interface LoadedModule { file: string; source: string; dependencies: string[]; imports: ModuleImport[]; hash: string }
export interface ModuleGraph { entry: string; modules: LoadedModule[] }

async function resolveSourceFile(requested: string): Promise<string | undefined> {
  const candidates = extname(requested) ? [requested] : [`${requested}.ts`, `${requested}.ets`];
  for (const candidate of candidates) {
    try { return await realpath(candidate); }
    catch {}
  }
  return undefined;
}

export async function loadModuleGraph(entry: string, options: ModuleLoaderOptions = {}): Promise<ModuleGraph> {
  const ordered: LoadedModule[] = [];
  const visited = new Set<string>();
  const visiting: string[] = [];

  const visit = async (requested: string): Promise<string> => {
    const file = await resolveSourceFile(requested);
    if (!file) throw new Error(`No se puede resolver el módulo '${requested}' (se probaron .ts y .ets)`);
    if (visited.has(file)) return file;
    const cycleIndex = visiting.indexOf(file);
    if (cycleIndex >= 0) throw new Error(`Ciclo de imports: ${[...visiting.slice(cycleIndex), file].join(" -> ")}`);
    visiting.push(file);
    const source = await readFile(file, "utf8");
    const stripped: string[] = [];
    const dependencies: string[] = [];
    const imports: ModuleImport[] = [];
    let lineNumber = 0;
    for (const line of source.split(/\r?\n/)) {
      lineNumber++;
      const match = line.match(IMPORT_LINE);
      if (!match) { stripped.push(line); continue; }
      const specifier = match[3];
      let dependency: string | undefined;
      if (specifier.startsWith(".")) dependency = resolve(dirname(file), specifier);
      else {
        const alias = Object.entries(options.aliases ?? {}).sort(([left], [right]) => right.length - left.length).find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
        if (alias) dependency = resolve(alias[1], specifier === alias[0] ? "" : specifier.slice(alias[0].length + 1));
        else {
          for (const root of options.moduleRoots ?? []) {
            const candidate = resolve(root, specifier);
            dependency = await resolveSourceFile(candidate);
            if (dependency) break;
          }
        }
      }
      if (!dependency) throw new Error(`No se puede resolver el import '${specifier}' desde ${file}`);
      const resolvedDependency = await visit(dependency);
      const names = match[2] ? match[2].split(",").map(name => name.trim()).filter(Boolean) : [];
      const invalidName = names.find(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      if (invalidName) throw new Error(`Import no válido '${invalidName}' en ${file}:${lineNumber}`);
      dependencies.push(resolvedDependency);
      imports.push({ names, dependency: resolvedDependency, line: lineNumber });
      stripped.push("");
    }
    const strippedSource = stripped.join("\n");
    // V15: nombre de inicializador estable (basado en el nombre del archivo,
    // no en un hash del source). Así, si un módulo cambia su source, su init
    // mantiene el mismo nombre y main.cpp no se invalida. El init solo cambia
    // si el módulo se RENOMBRA o se AÑADE uno nuevo.
    const moduleHash = createHash("sha256").update(strippedSource).digest("hex").slice(0, 16);
    visiting.pop();
    visited.add(file);
    ordered.push({ file, source: strippedSource, dependencies, imports, hash: moduleHash });
    return file;
  };

  const resolvedEntry = await visit(resolve(entry));
  return { entry: resolvedEntry, modules: ordered };
}

export async function compileFile(entry: string, options: ModuleLoaderOptions = {}): Promise<ModuleCompilationResult> {
  const graph = await loadModuleGraph(entry, options);
  const ordered = graph.modules;
  const visibilityPrograms = ordered.map(module => {
    try { return { module, ast: parse(module.source) }; }
    catch (error) {
      if (!(error instanceof DiagnosticError)) throw error;
      throw new DiagnosticError(error.diagnostics.map(diagnostic => ({ ...diagnostic, file: module.file, source: module.source })));
    }
  });
  validateModuleVisibility(visibilityPrograms);
  const ranges: Array<{ file: string; source: string; start: number; end: number }> = [];
  const chunks: string[] = [];
  let nextLine = 1;
  for (const module of ordered) {
    chunks.push(`// module: ${module.file}`);
    nextLine++;
    const count = module.source.split(/\r?\n/).length;
    ranges.push({ file: module.file, source: module.source, start: nextLine, end: nextLine + count - 1 });
    chunks.push(module.source);
    nextLine += count;
  }
  try {
    // V15: parseamos el AST combinado UNA VEZ (para que el type-checker
    // resuelva imports correctamente), pero el codegen emite header + un
    // `.cpp` por módulo (cada uno solo con su código). El header tiene
    // todas las declaraciones que cualquier módulo puede necesitar.
    const ast = parse(chunks.join("\n"));
    const { checker } = analyze([ast]);
    const generator = new CppGenerator(
      expression => checker.typeOf(expression),
      expression => checker.isVariadic(expression),
      expression => checker.typeArgumentsOf(expression),
    );
    // V16: si el usuario quiere minimal, el header `estatic_common.hpp` no
    // incluye `ets_io.hpp`. El usuario es responsable de usar `std::cout`
    // directamente o añadir su propio include.
    generator.minimal = options.minimal ?? false;
    generator.prepareModules(ast);
    const headerName = "estatic_common.hpp";
    const moduleInitializers = ordered.map(module => stableInitName(module.file));
    const header = generator.generateHeader(ast, moduleInitializers);
    // V15: en vez de parsear cada módulo por separado (lo que produce ASTs
  // distintos que el type-checker no reconoce), filtramos el AST combinado
  // por rango de líneas del módulo. Así los nodos que `generateModule`
  // recibe SON los del AST combinado, y `expressionType` (que es un
  // callback al type-checker del AST combinado) los reconoce.
  const modules = ordered.map((module, index) => {
    const range = ranges[index];
    const moduleStatementsFromCombined = (ast.statements as Statement[]).filter(stmt => {
      const line = stmt.span.start.line;
      return line >= range.start && line <= range.end;
    });
    const moduleAst: Program = { kind: "Program", statements: moduleStatementsFromCombined, span: { start: ast.span.start, end: ast.span.end } };
    return {
      name: module.file,
      cpp: generator.generateModule(moduleAst, ast, headerName, stableInitName(module.file), index === ordered.length - 1 ? moduleInitializers : undefined),
    };
  });
    return { ast, header, modules, moduleNames: ordered.map(m => m.file) };
  } catch (error) {
    if (!(error instanceof DiagnosticError)) throw error;
    const diagnostics: Diagnostic[] = error.diagnostics.map(diagnostic => {
      const range = ranges.find(candidate => diagnostic.span.start.line >= candidate.start && diagnostic.span.start.line <= candidate.end);
      if (!range) return diagnostic;
      const lineOffset = range.start - 1;
      return {
        ...diagnostic, file: range.file, source: range.source,
        span: {
          start: { ...diagnostic.span.start, line: diagnostic.span.start.line - lineOffset },
          end: { ...diagnostic.span.end, line: diagnostic.span.end.line - lineOffset }
        }
      };
    });
    throw new DiagnosticError(diagnostics);
  }
}
