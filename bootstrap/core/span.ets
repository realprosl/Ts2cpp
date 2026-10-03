// V22-W1: Migración de src/core/span.ts (7 LOC, trivial).
//
// Cambios respecto al TS original:
// - `interface Position` y `interface Span` → `class`. El dialecto solo
//   permite campos en clases; las interfaces son para métodos.
// - `export function span(start, end): Span` → `function span(...)`.
//   El dialecto no soporta inline object spread `{ ...start }`, así que
//   pasamos directamente las posiciones sin copiarlas (igual que TS por
//   convención — los callers no deben mutar Positions).

export class Position {
  offset: number;
  line: number;
  column: number;
  constructor(offset: number, line: number, column: number) {
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

export class Span {
  start: Position;
  end: Position;
  constructor(start: Position, end: Position) {
    this.start = start;
    this.end = end;
  }
}

export function span(start: Position, end: Position): Span {
  return new Span(start, end);
}