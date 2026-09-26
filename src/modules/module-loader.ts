import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { compile, parse, type CompilationResult } from "../compiler.ts";
import { DiagnosticError, type Diagnostic } from "../core/diagnostic.ts";
import { validateModuleVisibility } from "./module-visibility.ts";

const IMPORT_LINE = /^(\s*)import\s+(?:\{([^}]*)\}\s+from\s+)?["']([^"']+)["']\s*;\s*$/;

export interface ModuleCompilationResult extends CompilationResult { modules: string[] }
export interface ModuleLoaderOptions { moduleRoots?: string[]; aliases?: Record<string, string> }

export interface ModuleImport { names: string[]; dependency: string; line: number }
export interface LoadedModule { file: string; source: string; dependencies: string[]; imports: ModuleImport[] }
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
    visiting.pop();
    visited.add(file);
    ordered.push({ file, source: stripped.join("\n"), dependencies, imports });
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
    const result = compile(chunks.join("\n"));
    return { ...result, modules: ordered.map(module => module.file) };
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
