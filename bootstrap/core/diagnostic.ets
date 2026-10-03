// V22-W1: Migración de src/core/diagnostic.ts (105 LOC, moderado).
//
// Cambios respecto al TS original:
// - `process.env.NO_COLOR` y `process.stdout.isTTY` no se soportan en el
//   dialecto (no hay global `process`). Devolvemos siempre false: los
//   diagnósticos se imprimen en texto plano. Funcionalmente idéntico,
//   solo se pierden los colores ANSI.
//
// Para restaurar colores en el futuro: aceptar un parámetro `useColors`
// desde el caller (CLI puede leer process.env fuera del compilador).
//
// - `??` (nullish coalescing) y ternarios funcionan.
// - `===` y comparaciones funcionan.
// - `for...of` sobre array funciona.

import type { Span, Position } from "./span.ets";

// V22-W1: el dialecto no soporta `type X = "a" | "b"` (string literal union).
// Usamos string normal con comentario. Type-checker acepta strings como
// valores sin restringirlos al set.
export type DiagnosticPhase = string;  // "lexer" | "parser" | "semantic" | "codegen"
export type DiagnosticSeverity = string;  // "error" | "warning" | "note"

export class Diagnostic {
  phase: DiagnosticPhase;
  message: string;
  span: Span;
  file: string;
  source: string;
  severity: DiagnosticSeverity;
  notes: string[];
  hint: string;
  constructor(phase: DiagnosticPhase, message: string, span: Span) {
    this.phase = phase;
    this.message = message;
    this.span = span;
    this.file = "";
    this.source = "";
    this.severity = "error";
    this.notes = [];
    this.hint = "";
  }
}

// V22-W1: el dialecto no soporta `extends Error`. Creamos una clase
// con campo `name = "Error"` y delegamos en un `Error` interno.
export class DiagnosticError {
  diagnostics: Diagnostic[];
  message: string;
  name: string;
  constructor(diagnostics: Diagnostic[]) {
    let msg: string = "";
    let first: boolean = true;
    for (const d of diagnostics) {
      if (!first) msg = msg + "\n";
      msg = msg + numberToString(d.span.start.line) + ":" + numberToString(d.span.start.column) + " " + d.message;
      first = false;
    }
    this.message = msg;
    this.name = "DiagnosticError";
    this.diagnostics = diagnostics;
  }
  // Para compatibilidad con `instanceof Error` en callers JS.
  toString(): string {
    return this.name + ": " + this.message;
  }
}

// V22-W1: useColors desactivado — siempre texto plano.
// Cuando se llame desde el CLI, el caller puede prefijar ANSI manualmente.
function useColors(): boolean {
  return false;
}

const RESET: string = "";
const BOLD: string = "";
const DIM: string = "";
const RED: string = "";
const YELLOW: string = "";
const BLUE: string = "";
const CYAN: string = "";
const MAGENTA: string = "";

function colorize(text: string, color: string): string {
  return useColors() ? color + text + RESET : text;
}

function phaseColor(phase: DiagnosticPhase): string {
  if (phase == "lexer") return RED;
  if (phase == "parser") return YELLOW;
  if (phase == "semantic") return MAGENTA;
  return BLUE;
}

function severityColor(severity: DiagnosticSeverity): string {
  if (severity == "error") return RED;
  if (severity == "warning") return YELLOW;
  return CYAN;
}

function padStart(s: string, width: number): string {
  // V22-W1: el dialecto no tiene `padStart` built-in en strings.
  // Usamos `length(s)` para conocer el tamaño y añadir espacios manualmente.
  let result: string = s;
  while (length(result) < width) {
    result = " " + result;
  }
  return result;
}

function repeatChar(ch: string, count: number): string {
  let result: string = "";
  let i: number = 0;
  while (i < count) {
    result = result + ch;
    i = i + 1;
  }
  return result;
}

function padToWidth(num: number, width: number): string {
  return padStart(numberToString(num), width);
}

// V22-W1: split manual por `\n` porque el dialecto no tiene `String.split`.
// Devuelve un array con la línea i-1 en el índice i-1 (líneas 1-indexed).
function splitLines(src: string): string[] {
  let lines: string[] = [];
  let current: string = "";
  let i: number = 0;
  while (i < length(src)) {
    const ch: string = charAt(src, i);
    if (ch == "\n") {
      lines.push(current);
      current = "";
    } else if (ch == "\r") {
      // Ignoramos `\r` (CRLF handling simplificado).
    } else {
      current = current + ch;
    }
    i = i + 1;
  }
  lines.push(current);
  return lines;
}

function formatDiagnostic(file: string, source: string, diagnostic: Diagnostic): string {
  let f: string = diagnostic.file;
  if (f == "") f = file;
  let src: string = diagnostic.source;
  if (src == "") src = source;
  const severity: DiagnosticSeverity = diagnostic.severity;
  let sevStr: string = severity == "" ? "error" : severity;
  let header: string = colorize(sevStr, severityColor(sevStr))
    + colorize("[" + diagnostic.phase + "]", phaseColor(diagnostic.phase))
    + ": " + colorize(diagnostic.message, BOLD);
  let location: string = colorize("  --> " + f + ":" + numberToString(diagnostic.span.start.line) + ":" + numberToString(diagnostic.span.start.column), DIM);
  let lines: string[] = splitLines(src);
  let startLine: number = diagnostic.span.start.line;
  let endLine: number = diagnostic.span.end.line;
  let startColumn: number = diagnostic.span.start.column;
  let endColumn: number = diagnostic.span.end.column;
  let rendered: string[] = [header, location];
  if (startLine == endLine) {
    let line: string = lines[startLine - 1];
    if (line == "") line = "";
    let gutterWidth: number = length(numberToString(startLine));
    let lineNumber: string = colorize(padToWidth(startLine, gutterWidth), DIM) + colorize(" |", DIM);
    let caretLine: string = repeatChar(" ", Math.max(0, startColumn - 1))
      + colorize(repeatChar("^", Math.max(1, endColumn - startColumn)), severityColor(sevStr));
    rendered.push(lineNumber + " " + line);
    rendered.push(colorize(repeatChar(" ", gutterWidth), DIM) + colorize(" |", DIM) + " " + caretLine);
  } else {
    let firstLine: string = lines[startLine - 1];
    if (firstLine == "") firstLine = "";
    let lastLine: string = lines[endLine - 1];
    if (lastLine == "") lastLine = "";
    let gutterWidth: number = length(numberToString(endLine));
    rendered.push(colorize(padToWidth(startLine, gutterWidth), DIM) + colorize(" |", DIM) + " " + firstLine);
    rendered.push(colorize(repeatChar(" ", gutterWidth), DIM) + colorize(" |", DIM) + " " + colorize(repeatChar("^", Math.max(1, length(firstLine) - startColumn + 1)), severityColor(sevStr)));
    if (endLine - startLine > 1) rendered.push(colorize(" " + repeatChar(" ", gutterWidth) + " |\n", DIM));
    rendered.push(colorize(padToWidth(endLine, gutterWidth), DIM) + colorize(" |", DIM) + " " + lastLine);
    rendered.push(colorize(repeatChar(" ", gutterWidth), DIM) + colorize(" |", DIM) + " " + colorize(repeatChar("^", Math.max(1, endColumn)), severityColor(sevStr)));
  }
  if (length(diagnostic.notes) > 0) {
    for (const note of diagnostic.notes) {
      rendered.push(colorize("  = note: " + note, CYAN));
    }
  }
  if (diagnostic.hint != "") rendered.push(colorize("  = hint: " + diagnostic.hint, CYAN));
  // Join final.
  let result: string = "";
  let first2: boolean = true;
  for (const line of rendered) {
    if (!first2) result = result + "\n";
    result = result + line;
    first2 = false;
  }
  return result;
}

function formatDiagnostics(file: string, source: string, diagnostics: Diagnostic[]): string {
  let result: string = "";
  let first: boolean = true;
  for (const d of diagnostics) {
    if (!first) result = result + "\n\n";
    result = result + formatDiagnostic(file, source, d);
    first = false;
  }
  return result;
}