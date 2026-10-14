import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, resolve } from "node:path";
import { parse, analyze } from "../compiler.ts";
import { CppGenerator } from "../codegen/cpp-generator.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { validateModuleVisibility } from "./module-visibility.ts";
import { detectRuntimeBackends, type RuntimeBackends } from "./runtime-backends.ts";
import { computeModuleId, assertUniqueIdentities, type ModuleIdentity } from "./module-identity.ts";
import type { Program, Statement } from "../ast/nodes.ts";

// V22-gap-#1: soporta `import type { Foo } from "..."` (forma TS).
// También soporta `import { Foo } from "..."` (forma estándar).
// El flag `type` se ignora a nivel módulo: el dialecto emite los tipos
// en runtime igualmente, así que el comportamiento es idéntico.
//
// V30.6.1: ampliado H-05 del informe de revision. Soporta ahora:
//   - `import { Foo, Bar } from "x";`
//   - `import { Foo as Bar } from "x";`
//   - `import type { Foo } from "x";`
//   - `import * as Foo from "x";`
//   - `import Foo from "x";` (default)
//   - `import "x";` (side-effect)
//   - `import ... from "x";` con comentarios `// foo` al final
//   - `export { Foo } from "x";` (re-export, tratado como import)
// NO soporta (ver LIMITATIONS.md):
//   - imports multilínea (`import {\n  Foo\n} from "x";`) — el parser
//     del dialecto tampoco los soporta. Si los necesitas, ponelos en
//     una sola línea.
const IMPORT_LINE = /^\s*import\s+(?:type\s+)?(?:(\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*))|([A-Za-z_][A-Za-z0-9_]*)|(?:\{([^}]*)\}))?\s*(?:from\s+)?["']([^"']+)["']\s*;?\s*(?:\/\/.*)?$/;
const EXPORT_FROM_LINE = /^\s*export\s+(?:type\s+)?(?:\{([^}]*)\}\s+from|\*\s+from|\*\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s+from)\s+["']([^"']+)["']\s*;?\s*(?:\/\/.*)?$/;

/** V15: nombre de init estable basado en el nombre del archivo. Si el
 * módulo cambia su contenido, el init mantiene el mismo nombre — así
 * `main.cpp` no se invalida cada vez que una dependencia cambia.
 *
 * V30.6.1: delegado a `computeModuleId` (H-02 del informe de revision).
 * Antes, dos `index.ts` en carpetas distintas colisionaban en
 * `ets_init_index`. Ahora la ruta completa + hash garantiza unicidad. */
function stableInitName(moduleFile: string, baseDirectory: string): string {
  return computeModuleId(moduleFile, baseDirectory).initName;
}

export interface ModuleCompilationResult {
  ast: import("../ast/nodes.ts").Program;
  header: string;
  modules: { name: string; cpp: string }[];
  moduleNames: string[];
  /** V18: link flags y headers externos detectados por decoradores. */
  linkFlags: string[];
  externalHeaders: string[];
  /** V30.6.0: backends runtime que el programa necesita (libuv, curl, tls, io_uring).
   * Detectado mirando el AST, no escaneando includes del cpp (mas fiable). */
  runtimeBackends: RuntimeBackends;
}
export interface ModuleLoaderOptions { moduleRoots?: string[]; aliases?: Record<string, string>; minimal?: boolean; /** V30.6.1: raíz para derivar la identidad estable de módulo (H-01/H-02). */ baseDirectory?: string }

export interface ModuleImport { names: string[]; dependency: string; line: number }
export interface LoadedModule { file: string; source: string; dependencies: string[]; imports: ModuleImport[]; hash: string }
export interface ModuleGraph { entry: string; modules: LoadedModule[]; baseDirectory: string }

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
  // V30.6.1: baseDirectory se usa para derivar la identidad estable de
  // modulo (computeModuleId). Si no se pasa, usamos dirname(entry).
  const baseDirectory = options.baseDirectory ?? dirname(entry);

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
      // V30.6.1: intentar primero la regex de import normal, luego la
      // de export-from. Si ninguna matchea, la línea se preserva tal cual.
      let specifier: string | undefined;
      let importedNames: string[] = [];
      const importMatch = line.match(IMPORT_LINE);
      const exportMatch = !importMatch ? line.match(EXPORT_FROM_LINE) : null;
      if (importMatch) {
        // Grupos: 1=namespace, 2=namespaceName, 3=default, 4=names, 5=specifier
        specifier = importMatch[5];
        if (importMatch[4]) importedNames = importMatch[4].split(",").map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        else if (importMatch[2]) importedNames = [importMatch[2]]; // * as Foo
        else if (importMatch[3]) importedNames = [importMatch[3]]; // default
        else importedNames = []; // side-effect import
      } else if (exportMatch) {
        // Grupos: 1=names, 2=namespace, 3=specifier
        specifier = exportMatch[3];
        if (exportMatch[1]) importedNames = exportMatch[1].split(",").map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        else if (exportMatch[2]) importedNames = [exportMatch[2]];
      }
      if (!specifier) { stripped.push(line); continue; }
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
      const invalidName = importedNames.find(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
      if (invalidName) throw new Error(`Import no válido '${invalidName}' en ${file}:${lineNumber}`);
      dependencies.push(resolvedDependency);
      imports.push({ names: importedNames, dependency: resolvedDependency, line: lineNumber });
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
  return { entry: resolvedEntry, modules: ordered, baseDirectory };
}

export async function compileFile(entry: string, options: ModuleLoaderOptions = {}): Promise<ModuleCompilationResult> {
  const graph = await loadModuleGraph(entry, options);
  const ordered = graph.modules;
  const baseDirectory = graph.baseDirectory;
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
      name => checker.resolveTypeAliasFromAst(name),
      union => checker.resolveUnionAliasNameFromAst(union),
    );
    // V16: si el usuario quiere minimal, el header `estatic_common.hpp` no
    // incluye `ets_io.hpp`. El usuario es responsable de usar `std::cout`
    // directamente o añadir su propio include.
    generator.minimal = options.minimal ?? false;
    generator.prepareModules(ast);
    const headerName = "estatic_common.hpp";
    const moduleInitializers = ordered.map(module => stableInitName(module.file, baseDirectory));
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
      cpp: generator.generateModule(moduleAst, ast, headerName, stableInitName(module.file, baseDirectory), index === ordered.length - 1 ? moduleInitializers : undefined),
    };
  });
    return { ast, header, modules, moduleNames: ordered.map(m => m.file), linkFlags: generator.linkFlags, externalHeaders: generator.externalHeaders, runtimeBackends: detectRuntimeBackends(ast) };
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
