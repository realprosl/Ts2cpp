# Conversiones implícitas a enteros en comptime

El intérprete principal convierte al tipo entero de destino antes de almacenar
o entregar el valor. Usa las mismas reglas que los casts explícitos: módulo
2^N entre enteros, interpretación firmada para i8/i16/i32/i64 y truncado hacia
cero con comprobación de rango desde number/f32/f64. Los valores i64/u64
conservan sus dígitos mediante BigInt interno.

```ts
@comptime function narrow(x: u8): i8 { return x; }
const wide: i64 = 511;
const result: i8 = narrow(wide); // parámetro: 255; retorno: -1
```

La conversión cubre declaraciones escalares con tipo explícito, parámetros de
funciones nombradas (incluidas llamadas anidadas), retornos de funciones y
arrows, asignaciones simples y compuestas a variables, y escrituras simples
en campos o índices cuyo tipo escalar haya resuelto el checker. Los globals
evaluables se convierten antes de capturarlos. Los aliases expandidos conservan
el tipo de destino. Cada llamada restaura el contexto de retorno exterior.

Los errores de conversión flotante usan `COMPTIME_INTEGER_CAST_RANGE` para
valores truncados fuera de rango y `COMPTIME_INTEGER_CAST` para NaN/infinito.
El chequeo semántico previo de literales sigue vigente. El overflow aritmético
firmado continúa siendo un error; convertir un resultado no lo legitima.

## Límites

Las promociones aritméticas tipadas y callbacks se amplían en
[comptime-numeric-callbacks.md](./comptime-numeric-callbacks.md).
Los elementos de literales agregados tipados se convierten como se describe
en [comptime-aggregate-integers.md](./comptime-aggregate-integers.md).
Los callbacks arrow y destinos number/f32/f64 ya aplican conversiones
en el intérprete principal. El mini-evaluador
separado de `@etsgen` mantiene sus limitaciones. La API directa sin análisis
semántico no tiene todas las anotaciones necesarias.

## Verificación

`test/unit/comptime-implicit-integers.test.ts` añade 23 regresiones, todas
fallan contra v30. Una compila y ejecuta C++20 y compara variables, parámetros
y retornos con la evaluación comptime. Incluye 64 bits exactos, aliases,
sombreado, globals, campos, índices, llamadas y bloques anidados, y rechazo de
conversiones flotantes fuera de rango.

Ejemplo nativo verificado: `examples/comptime-implicit-integers/main.ets`.

```bash
node --experimental-strip-types src/cli.ts examples/comptime-implicit-integers/main.ets -o build/comptime-implicit-integers.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/comptime-implicit-integers.cpp -o build/comptime-implicit-integers
./build/comptime-implicit-integers
```

Salida: `signed=-1` y `byte=0`, en líneas separadas.
