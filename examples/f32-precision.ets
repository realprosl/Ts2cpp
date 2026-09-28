// V3 — f32 tiene menos precisión que f64. Este demo muestra que 0.1 + 0.2
// difiere ligeramente entre ambos tipos.
let a_f32: f32 = 0.1;
let b_f32: f32 = 0.2;
let sum_f32: f32 = a_f32 + b_f32;

let a_f64: f64 = 0.1;
let b_f64: f64 = 0.2;
let sum_f64: f64 = a_f64 + b_f64;

print("f32 0.1+0.2 =", sum_f32);
print("f64 0.1+0.2 =", sum_f64);