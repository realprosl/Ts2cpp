# Callbacks, flotantes y promociones numéricas

El intérprete principal y el checker comparten `src/types/numeric-semantics.ts`.
El backend conserva los tipos para que C++ aplique las mismas promociones.
La plataforma comprobada es C++20 con `int` de 32 bits, enteros de ancho fijo
y flotantes IEEE binary32/binary64, con redondeo al más cercano y empates a par.

## Promociones

| Operandos | Tipo de operación |
|---|---|
| i8/u8/i16/u16 | Se promueven primero a i32 |
| i32 y u32 | u32 |
| i64 y u32 (o enteros menores) | i64 |
| u64 y cualquier entero | u64 |
| f32 y entero, o dos f32 | f32 |
| f64 y otro tipo concreto | f64 |
| number y otro numérico, en aritmética | number (double) |

Una división entre enteros promovidos trunca hacia cero. Los intermedios
enteros se calculan con BigInt y se devuelven en la representación adecuada
del tipo promovido. Los unsigned envuelven a 32 o 64 bits; el overflow
aritmético firmado se rechaza con `COMPTIME_INTEGER_OVERFLOW`, incluida la
división o resto del mínimo firmado por -1.

En desplazamientos, cada operando se promueve independientemente y manda el
ancho del izquierdo. El conteo debe estar entre 0 y ancho-1. El desplazamiento
izquierdo conserva el patrón de bits módulo 2^ancho, también para signed,
como C++20. El checker conserva el tipo promovido de aritmética y unarios;
las comparaciones convierten sus operandos y producen boolean.
Los bitwise sobre f32/f64 explícitos se rechazan; el usuario debe convertir
primero a un entero.

Los literales sin contexto entero conservan el tipo number del dialecto.
Se mantiene el contexto especial i64/u64 para literales enteros adyacentes.
Por tanto, `i32 / number` sigue siendo flotante; para división entera ambos
operandos deben tener tipos enteros. Las reglas legacy de bitwise sobre
number se mantienen y requieren una auditoría separada.

## Flotantes

Las conversiones a number/f64 usan binary64. Las conversiones a f32 y los
resultados de operaciones f32 se redondean a binary32 en cada paso. Las
conversiones desde i64/u64 a f32 redondean directamente el entero, evitando
el doble redondeo que puede introducir pasar primero por un number.

Esto cubre destinos de variables, argumentos, retornos, asignaciones y
elementos agregados, además de los casts explícitos f32/f64. El backend
convierte argumentos directamente al tipo esperado, conserva -0.0 y emite
tokens flotantes válidos para magnitudes grandes o con exponente.

Los destinos flotantes pueden perder precisión, como en C++. La conversión
implícita tipada lo permite; la API no tipada de Math mantiene el diagnóstico
de pérdida de precisión al recibir un BigInt grande directamente. Para hacer
explícita esa pérdida se puede usar f64(valor) antes de Math.

Un overflow de f32 o resultado flotante no finito que se intenta materializar
como literal produce `COMPTIME_FLOAT_RANGE`. No se promete reproducir todos
los modos de redondeo, excepciones IEEE ni bibliotecas matemáticas nativas.

## Callbacks arrow

Los métodos evaluables convierten los valores entrantes al tipo del parámetro
de la arrow y sus retornos al tipo resuelto. Se permiten firmas con componentes
numéricos distintos por valor, igual que la adaptación de callables en C++;
los componentes no numéricos deben coincidir.

- map convierte además cada resultado al elemento de destino.
- reduce usa la firma del dialecto `reduce<U>(inicial, callback)`, convierte el
  inicial y cada acumulador a U, y devuelve el inicial convertido si está vacío.
- sort llama al comparador con los dos elementos y usa directamente su signo.
- filter, some, every y forEach convierten sus parámetros; flatMap evalúa
  la arrow y expande exactamente un nivel del array devuelto.

Las conversiones escalares no cambian los valores del array fuente. Los
métodos que mutan, como sort, mantienen su contrato de mutación.
Esto no añade evaluación general de funciones nombradas como callbacks,
objetos callable ni closures almacenadas; tampoco unifica el mini-evaluador
de @etsgen. Siguen pendientes higiene modular, recursos reales/agregados y
la auditoría completa de APIs, Math y bitwise legacy sobre number.

## Verificación

`comptime-numeric-callbacks.test.ts` añade 50 pruebas; 41 fallan contra v32.
Dos pruebas recorren los 121 pares de tipos numéricos: comprueban tipos y
división en el dialecto y los comparan con tipos/resultados de operadores
C++ independientes. Otras dos verificaciones nativas comparan operaciones
y pipelines de callbacks, y un caso de doble redondeo u64->f32 con llamada
runtime. También se cubren rangos, overflow, cero negativo y magnitudes grandes.

Ejemplo: `examples/comptime-numeric-callbacks/main.ets` combina map con
conversión i64->u8->f32, reduce f32 y comparación runtime/comptime.

Para reproducir el ejemplo:

```bash
node --experimental-strip-types src/cli.ts examples/comptime-numeric-callbacks/main.ets -o build/comptime-numeric-callbacks.cpp
g++ -std=c++20 -Werror=narrowing -O2 -pthread -fno-exceptions -I. build/comptime-numeric-callbacks.cpp -o build/comptime-numeric-callbacks
./build/comptime-numeric-callbacks
```

Salida verificada: `3`, `runtime=comptime`, `f32 rounding ok` y
`unsigned promotion ok`, en líneas separadas.
