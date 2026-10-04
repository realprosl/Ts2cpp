// describeValue: dispatch sobre un valor `string | number | boolean` usando
// la nueva sintaxis V23. Demuestra los cuatro caminos viables:
//
//   1. V23 con `when` por valor: cuando el subject es UN SOLO tipo y
//      queremos comparar contra literales concretos.
//   2. V23 con discriminator: cuando el subject es una clase/struct
//      con un campo `kind: string` (NO funciona con union cuyo kind
//      es enum — ver nota al final).
//   3. V23 con `whenType<T>`: cuando el subject es una union, el
//      codegen narrowa via `std::holds_alternative<T>` + `std::get<T>`
//      (V23.2, anade narrowing real que V23.1 no tenia). El callback
//      se invoca con 0 args; la discriminacion la hace el codegen.
//   4. V2 destructurada: para tagged unions con narrowing real del
//      payload Y exhaustividad enforced. RECOMENDADO cuando necesitas
//      acceder al valor narrowed en el callback.

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
// Patron 4: V2 destructurada (RECOMENDADO cuando necesitas el valor
// narrowed en el callback). Exhaustividad enforced en compilacion.
// ──────────────────────────────────────────────────────────────────────

union Value = S(string) | N(number) | B(boolean);

function describeValueV2(v: Value): string {
  return match (v) {
    case { kind: "S", value }: "string:" + value;
    case { kind: "N", value }: "number:" + numberToString(value);
    case { kind: "B", value }: "boolean:" + (value ? "true" : "false");
  };
}

print(describeValueV2(Value.S("hola")));
print(describeValueV2(Value.N(42)));
print(describeValueV2(Value.B(true)));

// ──────────────────────────────────────────────────────────────────────
// NOTA sobre unions y la forma V23 con discriminator:
// ──────────────────────────────────────────────────────────────────────
// `match(v, "kind", [...])` con `v: Union` NO funciona en V23.x porque
// las unions del dialecto representan `kind` como un `enum class` (no
// un `std::string`), y el codegen V23 emite `v.kind == std::string("S")`
// que no compila. Para dispatch sobre unions, usa el `whenType<T>`
// (patron 3) o la forma V2 destructurada (patron 4).
//
// Esto es un bug conocido del V23 que se resolveria en V24 emitiendo
// la comparación contra el enum value cuando el discriminator es un
// enum, pero requiere que el checker pase el tipo del discriminator al
// codegen. Por ahora, la regla es: V23 con discriminator solo funciona
// con clases/structs que tienen `kind: string` (no `kind: <enum>`).
