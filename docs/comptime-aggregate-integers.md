# Elementos numéricos de agregados en comptime

Los literales de arrays dinámicos, arrays fijos, tuplas y objetos con contexto
de interfaz convierten cada elemento escalar al tipo entero de destino.
Esto también funciona si el literal aparece como argumento o retorno de una
función. Se reutilizan las reglas de los casts: módulo entre enteros y truncado
con validación de rango desde flotantes. El tipo fuente se conserva para
distinguir ambas reglas.

```ts
const result: string = comptime((): string => {
  const source: i64 = 257;
  const bytes: u8[] = [source];
  const matrix: u8[][] = [[source]];
  return `${source}/${bytes[0]}/${matrix[0][0]}`;
}); // "257/1/1"
```

La conversión ocurre al construir el agregado. No modifica la variable fuente
ni recorre y reescribe arrays ya existentes. El checker sigue exigiendo tipos
compatibles para pasar arrays a funciones; no se añade una conversión implícita
de un vector i64[] completo a u8[]. Los aliases de campos se expanden antes de
validar su valor y se guarda `destinationType` en cada propiedad del AST.

Solo `...` expande un array dentro de otro. `[xs]` conserva `xs` como elemento;
`[...xs]` añade sus elementos una vez. Esto corrige el aplanado accidental que
rompía arrays anidados. Las capturas globales conservan los elementos convertidos.

El backend C++ emite casts numéricos en inicializadores de vectores y tuplas,
además de los ya existentes para arrays fijos, para evitar narrowing implícito.

## Verificación y límites

`comptime-aggregate-integers.test.ts` añade 23 regresiones: 22 fallan contra
v31. Cubren tipos firmados y unsigned, 64 bits, flotantes, aliases, shorthand,
campos array, argumentos y retornos, globals, tuplas y arrays anidados.
La prueba nativa compara arrays y tuplas con ejecución C++20 y compila con
`-Werror=narrowing`.

Los objetos que satisfacen interfaces tienen pruebas del evaluador; su emisión
directa runtime en C++ sigue incompleta (`{}` sin tipo concreto). El checker
todavía rechaza campos de tipo interfaz. Esto está anotado en `status.md`.
Las anotaciones nuevas no completan la emisión runtime de objetos ni el
mini-evaluador separado de `@etsgen`. Los parámetros de callbacks arrow,
destinos flotantes y promociones tipadas se cubren en
[comptime-numeric-callbacks.md](./comptime-numeric-callbacks.md).

Ejemplo nativo verificado:

```bash
node --experimental-strip-types src/cli.ts examples/comptime-aggregate-integers/main.ets -o build/comptime-aggregate-integers.cpp
g++ -std=c++20 -Werror=narrowing -O2 -pthread -fno-exceptions -I. build/comptime-aggregate-integers.cpp -o build/comptime-aggregate-integers
./build/comptime-aggregate-integers
```

Salida: `source=257, byte=1, nested=1, pair=257, field=1`.
