// V3 — Tour por los 10 tipos numéricos concretos.
// Literales siguen siendo `number` (= double) por compatibilidad con el
// codebase; los nuevos tipos requieren anotación explícita.

let a: i8 = -128;
let b: i16 = 32767;
let c: i32 = 2147483647;
let d: i64 = -9007199254740991;
let e: u8 = 255;
let f: u16 = 65535;
let g: u32 = 4294967295;
let h: u64 = 9007199254740991;
let pi_f32: f32 = 3.14159;
let pi_f64: f64 = 3.141592653589793;

print("i8 =", a);
print("i16 =", b);
print("i32 =", c);
print("i64 =", d);
print("u8 =", e);
print("u16 =", f);
print("u32 =", g);
print("u64 =", h);
print("f32 =", pi_f32);
print("f64 =", pi_f64);

// Casts cruzados: number → i32 trunca; i32 → f64 widenning.
function toI32(x: number): i32 { return x; }
function toF64(x: i32): f64 { return x; }

let truncated: i32 = toI32(3.7);
let widened: f64 = toF64(42);
print("truncated 3.7 =", truncated);
print("widened 42 =", widened);