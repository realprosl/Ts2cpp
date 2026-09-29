// V6 — Constantes propagadas (constexpr).
// `const N: i32 = 4` se conoce en compilación; el codegen emite
// `static constexpr int32_t N = ...`. Los tamaños de arrays fijos que
// usan `N` se propagan al literal antes de validateType, permitiendo
// `std::array<T, 4>` constexpr (sin N simbólica).

const N: i32 = 4;
let buf: u8[N] = [10, 20, 30, 40];
print("buf[0]:", buf[0]);
print("buf[3]:", buf[3]);

// Constantes independientes se emiten también como constexpr.
const LIMIT: i32 = 1024;
print("LIMIT:", LIMIT);

// Strings literales también funcionan, pero `constexpr std::string` no
// es válido en C++ estándar (el ctor usa heap). El codegen emite `const
// std::string` en lugar de `constexpr std::string` para no romper.
const NAME: string = "constexpr-string";
print("NAME:", NAME);