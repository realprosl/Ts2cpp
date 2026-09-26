#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Lexer } from "../lexer/lexer.ts";
import { Parser } from "../parser/parser.ts";
import { TypeChecker } from "../semantic/type-checker.ts";
import { DiagnosticError, formatDiagnostic } from "../core/diagnostic.ts";
import type {
  Program, Statement, Parameter, FunctionDeclaration, ClassDeclaration,
  InterfaceDeclaration, VariableDeclaration,
} from "../ast/nodes.ts";

// Extractor de documentación. Recorre las declaraciones top-level y emite firmas
// legibles. No usa semántica para "decorar" (los tipos ya están en el AST), pero
// corre el TypeChecker cuando hace falta para resolver tipos de expresiones.
//
// --format md (por defecto) o --format json.

type DocEntry =
  | { kind: "function"; exported: boolean; name: string; typeParameters: string[]; params: Parameter[]; returnType: string }
  | { kind: "class"; exported: boolean; name: string; typeParameters: string[]; fields: { name: string; type: string }[]; methods: { name: string; typeParameters: string[]; params: Parameter[]; returnType: string }[] }
  | { kind: "interface"; exported: boolean; name: string; methods: { name: string; typeParameters: string[]; params: Parameter[]; returnType: string }[] }
  | { kind: "variable"; exported: boolean; name: string; declaredType?: string };

function formatParameter(parameter: Parameter): string {
  const passing = parameter.passing === "automatic" ? "" : `${parameter.passing} `;
  const variadic = parameter.variadic ? "..." : "";
  return `${parameter.out ? "out " : passing}${variadic}${parameter.name}: ${parameter.type}`;
}

// Renderiza una lista de `TypeParameter` (en el formato del AST) como `<T, U extends I, V = D>`.
// Reconstruye las cláusulas `extends` y `= default` a partir de los campos del nodo.
function formatTypeParameters(parameters: { name: string; constraint?: string; default?: string }[]): string {
  if (!parameters.length) return "";
  const inner = parameters.map(p => `${p.name}${p.constraint ? ` extends ${p.constraint}` : ""}${p.default ? ` = ${p.default}` : ""}`).join(", ");
  return `<${inner}>`;
}

function collect(program: Program): DocEntry[] {
  const entries: DocEntry[] = [];
  for (const statement of program.statements) collectStatement(statement, entries);
  return entries;
}

function collectStatement(statement: Statement, entries: DocEntry[]): void {
  switch (statement.kind) {
    case "FunctionDeclaration":
      entries.push(collectFunction(statement));
      break;
    case "ClassDeclaration":
      entries.push(collectClass(statement));
      break;
    case "InterfaceDeclaration":
      entries.push(collectInterface(statement));
      break;
    case "VariableDeclaration":
      entries.push(collectVariable(statement));
      break;
    // El resto (if, while, for, blocks...) no produce documentación top-level.
    default:
      break;
  }
}

function collectFunction(declaration: FunctionDeclaration): DocEntry {
  return {
    kind: "function",
    exported: !!declaration.exported,
    name: declaration.name,
    typeParameters: declaration.typeParameters.map(parameter => parameter.name),
    params: declaration.params,
    returnType: declaration.returnType,
  };
}

function collectClass(declaration: ClassDeclaration): DocEntry {
  return {
    kind: "class",
    exported: !!declaration.exported,
    name: declaration.name,
    typeParameters: declaration.typeParameters.map(parameter => parameter.name),
    fields: declaration.fields.map((field) => ({ name: field.name, type: field.type })),
    methods: declaration.methods.map((method) => ({
      name: method.name,
      typeParameters: (method.typeParameters ?? []).map(parameter => parameter.name),
      params: method.params,
      returnType: method.returnType,
    })),
  };
}

function collectInterface(declaration: InterfaceDeclaration): DocEntry {
  return {
    kind: "interface",
    exported: !!declaration.exported,
    name: declaration.name,
    methods: declaration.methods.map((method) => ({
      name: method.name,
      typeParameters: (method.typeParameters ?? []).map(parameter => parameter.name),
      params: method.params,
      returnType: method.returnType,
    })),
  };
}

function collectVariable(declaration: VariableDeclaration): DocEntry {
  return {
    kind: "variable",
    exported: !!declaration.exported,
    name: declaration.name,
    declaredType: declaration.declaredType,
  };
}

function renderMarkdown(entries: DocEntry[], sourceName: string): string {
  const lines: string[] = [`# ${sourceName}`, ""];
  for (const entry of entries) {
    const exported = entry.exported ? " *(exported)*" : "";
    if (entry.kind === "function") {
      const tp = entry.typeParameters.length ? `<${entry.typeParameters.join(", ")}>` : "";
      const params = entry.params.map(formatParameter).join(", ");
      lines.push(`## function ${entry.name}${tp}(${params}): ${entry.returnType}${exported}`, "");
    } else if (entry.kind === "class") {
      const tp = entry.typeParameters.length ? `<${entry.typeParameters.join(", ")}>` : "";
      lines.push(`## class ${entry.name}${tp}${exported}`, "");
      if (entry.fields.length) {
        lines.push("### Fields", "");
        for (const field of entry.fields) lines.push(`- \`${field.name}: ${field.type}\``);
        lines.push("");
      }
      if (entry.methods.length) {
        lines.push("### Methods", "");
        for (const method of entry.methods) {
          const mtp = method.typeParameters.length ? `<${method.typeParameters.join(", ")}>` : "";
          const mparams = method.params.map(formatParameter).join(", ");
          lines.push(`- \`${method.name}${mtp}(${mparams}): ${method.returnType}\``);
        }
        lines.push("");
      }
    } else if (entry.kind === "interface") {
      lines.push(`## interface ${entry.name}${exported}`, "");
      lines.push("### Methods", "");
      for (const method of entry.methods) {
        const mtp = method.typeParameters.length ? `<${method.typeParameters.join(", ")}>` : "";
        const mparams = method.params.map(formatParameter).join(", ");
        lines.push(`- \`${method.name}${mtp}(${mparams}): ${method.returnType}\``);
      }
      lines.push("");
    } else if (entry.kind === "variable") {
      const type = entry.declaredType ?? "inferred";
      lines.push(`## ${entry.name}: ${type}${exported}`, "");
    }
  }
  return lines.join("\n");
}

interface CliOptions { inputPath?: string; format: "md" | "json" }

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { format: "md" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--format") {
      const value = argv[++index];
      if (value === "md" || value === "json") options.format = value;
    } else if (arg.startsWith("--")) {
      // Flag desconocido: lo ignoramos pero consumimos su valor si lo tiene.
      if (index + 1 < argv.length && !argv[index + 1].startsWith("--")) index++;
    } else if (!options.inputPath) {
      options.inputPath = arg;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const useStdin = !options.inputPath;
let source: string;
let sourceName = "<stdin>";

if (useStdin) {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  source = Buffer.concat(chunks).toString("utf8");
} else {
  source = await readFile(options.inputPath!, "utf8");
  sourceName = options.inputPath!;
}

const format = options.format;

try {
  const tokens = new Lexer(source).tokenize();
  const program = new Parser(tokens).parseProgram();
  // TypeChecker solo se ejecuta para validar que el código está bien tipado.
  // Si falla, lo reportamos pero seguimos emitiendo las firmas del AST puro.
  let warnings: string[] = [];
  try { new TypeChecker().check(program); }
  catch (error) {
    if (error instanceof DiagnosticError) {
      warnings = error.diagnostics.map((d) => `línea ${d.span.start.line}: ${d.message}`);
    } else throw error;
  }
  const entries = collect(program);
  if (format === "json") {
    process.stdout.write(JSON.stringify({ source: sourceName, entries, warnings }, null, 2));
    process.stdout.write("\n");
  } else {
    process.stdout.write(renderMarkdown(entries, sourceName));
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
  }
} catch (error) {
  if (error instanceof DiagnosticError) {
    for (const diagnostic of error.diagnostics) console.error(formatDiagnostic(sourceName, source, diagnostic));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
