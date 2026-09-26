import type { Span } from "./span.ts";

export interface Diagnostic { phase: "lexer" | "parser" | "semantic" | "codegen"; message: string; span: Span; file?: string; source?: string; severity?: "warning" | "error" }

export class DiagnosticError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n"));
    this.name = "DiagnosticError";
    this.diagnostics = diagnostics;
  }
}

export function formatDiagnostic(file: string, source: string, diagnostic: Diagnostic): string {
  file = diagnostic.file ?? file;
  source = diagnostic.source ?? source;
  const line = source.split(/\r?\n/)[diagnostic.span.start.line - 1] ?? "";
  const caret = " ".repeat(Math.max(0, diagnostic.span.start.column - 1)) + "^";
  return `${file}:${diagnostic.span.start.line}:${diagnostic.span.start.column}: ${diagnostic.phase}: ${diagnostic.message}\n${line}\n${caret}`;
}
