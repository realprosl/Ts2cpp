// describeValue: dispatch sobre un valor `string | number | boolean` usando
// la sintaxis V23 (unica admitida en V30, despues de eliminar V2).
//
// Las tres formas validas:
//
//   1. V23 con `when` por valor: cuando el subject es UN SOLO tipo y
//      queremos comparar contra literales concretos.
//   2. V23 con discriminator: cuando el subject es una clase/struct
//      con un campo `kind: string`.
//   3. V23 con `whenType<T>`: cuando el subject es una union, el
//      codegen narrowa via `std::holds_alternative<T>` + `std::get<T>`.
//      El callback se invoca con 0 args; la discriminacion la hace
//      el codegen.
//
// V30 elimino la forma V2 destructurada (`match (r) { case { kind: ... }: ...; }`)
// porque no era TS-compatible (el LSP subrayaba la sintaxis en rojo).
// Si necesitas acceder al valor narrowed del payload, usa `whenType<T>`
// (forma 3) o un `if` dentro del callback con discriminator (forma 2).

// ──────────────────────────────────────────────────────────────────────
// Patron 1: V23 con `when` por valor (un solo tipo en el subject)
// ──────────────────────────────────────────────────────────────────────

function describeNumber(n: number): string {
  return match(n, [
    when(0, (v: number): string => "cero"),
    when(1, (v: number): string => "uno"),
    when(2, (v: number): string => "dos"),
    otherwise((): string => "otro: " + numberToString(n)),
  ]);
}

print(describeNumber(0));
print(describeNumber(1));
print(describeNumber(42));

// ──────────────────────────────────────────────────────────────────────
// Patron 2: V23 con discriminator sobre una clase con `kind: string`
// ──────────────────────────────────────────────────────────────────────

class AnyValue {
  kind: string;
  strVal: string;
  numVal: number;
  blnVal: boolean;
  constructor(k: string, s: string, n: number, b: boolean) {
    this.kind = k;
    this.strVal = s;
    this.numVal = n;
    this.blnVal = b;
  }
}

function describeValueV23(v: AnyValue): string {
  return match(v, "kind", [
    when("string",  (x: AnyValue): string => "string:"  + x.strVal),
    when("number",  (x: AnyValue): string => "number:"  + numberToString(x.numVal)),
    when("boolean", (x: AnyValue): string => "boolean:" + (x.blnVal ? "true" : "false")),
  ]);
}

print(describeValueV23(new AnyValue("string",  "hola", 0.0,  false)));
print(describeValueV23(new AnyValue("number",  "",     42.0,  false)));
print(describeValueV23(new AnyValue("boolean", "",     0.0,   true)));

// ──────────────────────────────────────────────────────────────────────
// Patron 3: V23 con whenType<T> sobre union (V23.2 — narrowing via
// std::holds_alternative). El callback se invoca con 0 args; la
// discriminacion la hace el codegen.
// ──────────────────────────────────────────────────────────────────────

function describeWhenType(v: string | number | boolean): void {
  match(v, [
    whenType<string>(() => print("is string")),
    whenType<number>(() => print("is number")),
    whenType<boolean>(() => print("is boolean")),
  ]);
}

describeWhenType("hola");
describeWhenType(42);
describeWhenType(true);

// ──────────────────────────────────────────────────────────────────────
// NOTA: V30 elimino la forma V4 (V2 destructurada) del ejemplo
// original. El acceso al valor narrowed del payload de una tagged
// union ahora se hace con `whenType<T>` (forma 3) cuando el subject
// es una union, o con un `if (v.kind === "S") { ... }` dentro del
// callback cuando se usa discriminator (forma 2).
// ──────────────────────────────────────────────────────────────────────
