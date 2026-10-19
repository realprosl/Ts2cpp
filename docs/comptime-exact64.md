# Valores exactos de 64 bits

El intérprete principal almacena los valores i64/u64 como `bigint` de JS.
Los operandos, resultados intermedios, bindings, argumentos, arrays y retornos
modelados ya no necesitan caber en los 53 bits seguros de un `number`.
La aritmética firmada comprueba el rango de i64; la unsigned usa módulo 2^64.
La división trunca hacia cero y las comparaciones conservan los dígitos.

Los literales en contextos i64/u64 se leen desde el token original, incluidos
decimal, hexadecimal, binario, octal y separadores `_`. Así, el valor ya
redondeado por `Number(token)` no se usa como fuente del entero. Los límites
se comprueban con BigInt, incluido el mínimo firmado con signo unario.

## AST y emisión C++

El AST sigue siendo serializable como JSON: `exactInteger` contiene el decimal
canónico y `integerType` identifica i64/u64 en literales y unarios normalizados.
Para estos nodos, esos campos son autoritativos. `value` conserva un number
aproximado por compatibilidad con la estructura previa; un consumidor del AST
debe consultar `exactInteger` para recuperar el valor exacto.

El checker conserva tipos de 64 bits en las operaciones entre enteros de esa
familia y da contexto entero a literales adyacentes. Las comparaciones mixtas
i64/u64 aplican promoción unsigned. El backend emite constantes LL/ULL con
casts al tipo exacto, incluyendo una forma válida para -2^63. Las operaciones
entre operandos i64/u64, sus llamadas tipadas y `print` evitan la conversión
intermedia a double. La concatenación de strings usa formato entero.

## Conversiones y límites restantes

- `number`, f32 y f64 mantienen semántica flotante. No se añade sintaxis de
  BigInt arbitrario al dialecto. Las promociones tipadas se describen en
  [comptime-numeric-callbacks.md](./comptime-numeric-callbacks.md).
- El evaluador rechaza con `COMPTIME_INTEGER_PRECISION` una conversión interna
  de un entero grande a number que pudiera perder precisión, por ejemplo al
  enviarlo a `Math.sqrt`. No convierte silenciosamente el BigInt a double.
- La ruta exacta requiere anotaciones del checker o metadatos normalizados.
  La API de bajo nivel `evaluateComptime(parse(...))` por sí sola no completa
  el chequeo semántico de enteros.
- El mini-evaluador de `@etsgen` sigue separado. Si recibe un literal exacto
  grande o lee un global exacto grande, emite `ETSGEN_INTEGER_PRECISION`.
  Su soporte de aritmética y ámbitos no se amplía en esta revisión.
- Los casts explícitos i8/u8/i16/u16/i32/u32/i64/u64 convierten entre enteros
  por módulo 2^N con interpretación firmada cuando corresponde (C++20).
  Desde number/f32/f64 truncan hacia cero y comprueban el rango de destino:
  `COMPTIME_INTEGER_CAST_RANGE` para desbordamiento, `COMPTIME_INTEGER_CAST`
  para NaN/infinito. Se mantiene el chequeo previo de rango de literales.
  Hay 18 regresiones adicionales en `comptime-integer-casts.test.ts`, con
  14 conversiones comparadas contra ejecución nativa.
- Las conversiones implícitas escalares a enteros en variables, parámetros
  de funciones y retornos se describen en [comptime-implicit-integers.md](./comptime-implicit-integers.md).
  Los literales agregados tipados también convierten elementos; ver
  [comptime-aggregate-integers.md](./comptime-aggregate-integers.md).
  Los callbacks arrow, destinos flotantes y promociones tipadas están
  cubiertos en [comptime-numeric-callbacks.md](./comptime-numeric-callbacks.md).
  Las conversiones explícitas a tipos flotantes en C++ pueden perder precisión
  por la propia semántica del tipo destino.
- El presupuesto sigue siendo lógico (8 bytes por escalar), no heap real de
  BigInt. Faltan contabilidad real/agregada e higiene modular.

Hay 28 regresiones nuevas; 25 fallan contra v28. Cubren límites, bases,
intermedios, wrap, comparaciones, aliases, arrays, templates, casts básicos,
rechazos de conversión y AST JSON. Una compila y ejecuta C++20 con límites
exactos, paso a otra función, concatenación y comparación de enteros consecutivos.
La regresión antigua que rechazaba 9007199254740993 ahora exige conservarlo.

Ejemplo reproducible:

```bash
node --experimental-strip-types src/cli.ts examples/comptime-exact64/main.ets -o build/comptime-exact64.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/comptime-exact64.cpp -o build/comptime-exact64
./build/comptime-exact64
```

Salida: `18446744073709551615`, `-9223372036854775808`,
`18446744073709551615`, `max=18446744073709551615`, `distinct`, en líneas separadas.
