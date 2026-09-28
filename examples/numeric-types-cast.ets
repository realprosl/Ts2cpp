// V3 — Casts entre tipos numéricos concretos. Demuestra widening/truncamiento
// explícito entre i*, u*, f* y el number base (double).
function toI32(x: number): i32 { return x; }
function toF64(x: i32): f64 { return x; }
function toU32(x: i32): u32 { return x; }
function toF32(x: number): f32 { return x; }

let pi: number = 3.14159;
let truncated: i32 = toI32(pi);
let widened: f64 = toF64(42);
let signedToUnsigned: u32 = toU32(100);
let asF32: f32 = toF32(2.71828);

print("3.14159 trunc to i32:", truncated);
print("42 widen to f64:", widened);
print("100 signed to u32:", signedToUnsigned);
print("2.71828 to f32:", asF32);