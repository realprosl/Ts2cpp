// V4 — Arrays de tamaño fijo: sintaxis T[N] → std::array<T, N> en pila.

let u8buf: u8[4] = [10, 20, 30, 40];
print("u8[0]:", u8buf[0]);
print("u8[3]:", u8buf[3]);

let i32buf: i32[3] = [100, 200, 300];
print("i32[1]:", i32buf[1]);
i32buf[2] = 999;
print("i32[2] after assign:", i32buf[2]);

let fbuf: f64[2] = [3.14, 2.71];
print("f64[0]:", fbuf[0]);
print("f64[1]:", fbuf[1]);

// u8[N] es la representación de V4: array en pila, tamaño estático.
let small: u8[4] = [10, 20, 30, 40];
print("small[0]:", small[0]);
print("small[3]:", small[3]);