# Operaciones i64/u64 en comptime

El intérprete principal usa `BigInt` internamente para los operadores `+`,
`-`, `*`, `/`, `%`, `&`, `|`, `^`, `<<`, `>>` y los unarios `+`, `-`, `~`
cuando el checker ha anotado un tipo `i64` o `u64`. Las asignaciones compuestas
usan también el tipo del destino. El parser recompone los desplazamientos
desde los tokens `<`, `>` del lexer y reconoce el unario `~`.

Esto corrige la reducción accidental a 32 bits de los operadores JavaScript
y la división decimal: una división `i64` de `-7 / 2` produce `-3`, mientras
que `number` mantiene `-3.5`. Los conteos de desplazamiento deben estar entre
0 y 63. `u64` aplica módulo 2^64 al resultado de la operación; un overflow
signed aritmético produce error conservador en tiempo de compilación.
Los desplazamientos izquierdos usan el patrón de bits módulo 2^64 de C++20.

## Almacenamiento exacto desde v29

Los valores persistentes ya usan BigInt y los literales sintetizados guardan
texto decimal exacto en el AST. La limitación de 53 bits de v28 está retirada
en la ruta i64/u64 tipada; ver [`comptime-exact64.md`](comptime-exact64.md).
Se conservan resultados e intermedios grandes sin redondear a number.

Los códigos de diagnóstico son:

- `COMPTIME_INTEGER_PRECISION`: conversión a number que perdería precisión.
- `COMPTIME_INTEGER_OVERFLOW`: resultado signed fuera de i64.
- `COMPTIME_INTEGER_SHIFT`: desplazamiento negativo o mayor que 63.
- `COMPTIME_INTEGER_DIVISION_ZERO`: división o resto entero por cero.

Se preserva el span de la operación. Estos errores no son valores runtime
no disponibles y no activan el fallback de una función decorada.

La ruta requiere las anotaciones semánticas que aportan `compile` y
`compileFile`. Llamar directamente a `evaluateComptime(parse(...))` no las
añade. Las promociones de i8..u64 y destinos flotantes se amplían en
[comptime-numeric-callbacks.md](./comptime-numeric-callbacks.md). No se unifica
el mini-evaluador de `@etsgen` ni se auditan todas las APIs externas.
Esta corrección no da por terminado `comptime`.

Hay 21 pruebas nuevas: resultados, precedencia, diagnósticos, asignación
compuesta, división flotante y fallback runtime. Diecinueve fallan contra v27.
Una compila y ejecuta C++ para contrastar los resultados plegados con los de
funciones runtime. El ejemplo imprime `shift`, `exact`, `-3`, `-3`:

```bash
node --experimental-strip-types src/cli.ts examples/comptime-integer64/main.ets -o build/comptime-integer64.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/comptime-integer64.cpp -o build/comptime-integer64
./build/comptime-integer64
```
