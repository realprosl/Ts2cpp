// numeric-literal.ets — Bloque C: literales numéricos no decimales y
// separadores. El dialecto acepta los formatos:
//   - Hexadecimal:    0xFF, 0X1A, 0xFF_FF_FF
//   - Octal:          0o77, 0O7
//   - Binario:        0b1010, 0B0
//   - Decimal:        42, 1_000_000
// El codegen emite hex tal cual (`0xFF.0p0` en C++ para forzar `double`)
// y convierte octal/binario a decimal porque C++ estándar no los soporta.

// Hexadecimal: 0xFF = 255
print(0xFF);
print(0X1A);                // 26
print(0xFF_FF_FF);          // 16777215 — separadores ignorados

// Octal: 0o77 = 63
print(0o77);
print(0O7);                 // 7

// Binario: 0b1010 = 10
print(0b1010);
print(0B1111);              // 15

// Decimal con separadores
print(1_000_000);           // 1000000
print(1_000);               // 1000

// Aritmética con literales no decimales
print(0x10 + 5);            // 21
print(0b1111 * 2);          // 30
print(0o10 - 1);            // 7
print(0xFF - 0o77);         // 255 - 63 = 192

// Uso práctico: máscaras de bits
const READ: number = 0b001;
const WRITE: number = 0b010;
const EXEC: number = 0b100;
const RWX: number = READ | WRITE | EXEC;
print(RWX);                 // 7
print((RWX & READ) > 0);    // 1 (true)
print((RWX & 0b1000) > 0);  // 0 (false)
