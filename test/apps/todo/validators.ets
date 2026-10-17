// V30.53: Validadores comptime.
// Demuestra @comptime + recursion comptime para validacion.

// Prioridad válida: 0 (low), 1 (med), 2 (high).
@comptime
export function isValidPriority(p: number): boolean {
  return p == 0 || p == 1 || p == 2;
}

// Convierte prioridad numerica a string ("low" | "med" | "high").
@comptime
export function priorityToString(p: number): string {
  if (p == 0) { return "low"; }
  if (p == 1) { return "med"; }
  return "high";
}

// Convierte string a prioridad numerica. comptime() evalua la
// comparacion de strings en compile-time.
export function stringToPriority(s: string): number {
  if (s == "low") { return 0; }
  if (s == "med") { return 1; }
  if (s == "high") { return 2; }
  return 1;  // default: med
}

// Valida que un texto no este vacio y no exceda 200 chars.
@comptime
export function isValidText(t: string): boolean {
  return length(t) > 0 && length(t) <= 200;
}

// Valida que un ID sea un numero positivo (1, 2, 3, ...).
@comptime
export function isValidId(id: number): boolean {
  return id > 0;
}

// Suma checksum comptime (para IDs derivados del storage).
@comptime
export function priorityWeight(p: number): number {
  return p * 10;
}
