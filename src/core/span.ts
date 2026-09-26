export interface Position { offset: number; line: number; column: number }
export interface Span { start: Position; end: Position }

export function span(start: Position, end: Position): Span {
  return { start: { ...start }, end: { ...end } };
}
