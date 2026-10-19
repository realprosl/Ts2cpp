# Optimización de métodos encadenados

## Objetivo

Reducir copias y asignaciones intermedias en cadenas de métodos sobre `string`
y `Array<T>`, aprovechando movimientos, referencias constantes y reutilización
segura de temporales. La optimización no puede cambiar el dato inicial ni la
semántica observable del programa.

```ets
const source: number[] = [1, 2, 3, 4];
const result: number[] = source.filter((x: number): boolean => x > 1)
                               .map((x: number): number => x * 2);

// Debe seguir siendo [1, 2, 3, 4]. Solo los temporales de la cadena pueden
// consumirse o reutilizar su almacenamiento.
```

## Reglas que debe conservar el compilador

- Un receptor nombrado se trata como `const&` cuando el método es inmutable.
  No se mueve ni se modifica implícitamente para acelerar la cadena.
- Un receptor temporal puede consumirse mediante overloads `&&` y reutilizar
  capacidad o buffer cuando el tipo y la operación lo permiten.
- Los métodos declarados mutables mantienen su semántica explícita y no se
  confunden con transformaciones que devuelven un valor nuevo.
- Una referencia, alias, closure o préstamo vivo impide reutilizar el objeto
  al que apunta. La optimización debe apoyarse en ownership y análisis de
  escapes, no únicamente en que el nombre no vuelva a aparecer.
- El resultado debe ser idéntico con la optimización activada o desactivada,
  incluidos orden, excepciones/errores, callbacks y efectos secundarios.

## Trabajo pendiente

### Auditoría realizada (v24)

La fusión antigua de `filter().map().reduce()` se ha retirado. No comprobaba
pureza: intercalaba predicado, transformación y acumulación por elemento, en
vez de completar cada etapa. Su lambda exterior sin captura también impedía
compilar pipelines sobre arrays locales y parámetros. La ruta conservadora
usa los helpers existentes: observan la fuente por `const&`, crean vectores
independientes y conservan el orden eager de los callbacks.

Hay nueve regresiones nuevas, incluidas tres que compilan y ejecutan C++20:
orden de callbacks, capturas locales, repetición sin modificar la fuente,
arrays vacíos, cambio de tipo y pipelines anidados con callbacks nombrados.
No son benchmarks ni certifican ausencia de fugas. La retirada recupera
vectores intermedios: puede aumentar asignaciones y tiempo respecto al bucle
fusionado. No se ha medido todavía ese coste.

No se resuelve aquí el orden general de evaluación de argumentos con efectos
en C++. La revisión v25 corrige capturas léxicas de lambdas anidadas por
identidad de símbolo; ver [`closure-captures.md`](closure-captures.md).
La revisión v26 añade una protección parcial de retornos de tipo función;
ver [`closure-return-safety.md`](closure-return-safety.md). El análisis completo
de escapes y lifetimes de capturas por referencia sigue pendiente.

Ejemplo reproducible (salida: `55`, `1`, `2`, `3`, en líneas separadas):

```bash
node --experimental-strip-types src/cli.ts examples/array-pipeline-semantics/main.ets -o build/array-pipeline-semantics.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/array-pipeline-semantics.cpp -o build/array-pipeline-semantics
./build/array-pipeline-semantics
```

### Base del compilador

- Anotar en la IR tipada la categoría de cada receptor: lvalue, const lvalue o
  temporal consumible.
- Integrar último uso, aliases, préstamos y escapes antes de elegir movimiento
  o referencia.
- Describir en metadatos de cada método si observa, muta, consume o produce un
  valor independiente; evitar decisiones basadas en nombres de métodos.
- Mantener una ruta conservadora cuando el análisis no pueda demostrar que la
  transformación es segura.

### `Array<T>`

- Medir vectores, reservas y movimientos de la ruta conservadora para tipos
  primitivos y no triviales; comparar cualquier optimización contra esa base.
- Mantener el array inicial por referencia constante. Solo fusionar operaciones
  cuya pureza y ausencia de efectos observables de reordenamiento se prueben;
  el nombre del método o que el tipo sea primitivo no bastan.
- Reutilizar la capacidad únicamente de temporales exclusivos; nunca la del
  array inicial ni la de un valor con aliases o préstamos vivos.
- Propagar movimientos de elementos cuando el elemento sea movible y la fuente
  sea un temporal consumible; copiar cuando provenga del dato inicial.
- Reservar capacidad cuando pueda estimarse sin alterar el orden de callbacks.

### `string`

- Añadir rutas `const&` y `&&` a las transformaciones que devuelven otro string.
- Reutilizar el buffer de temporales exclusivos en cadenas compatibles como
  normalización de mayúsculas/minúsculas y recortes.
- Mantener el string inicial intacto y evitar `std::move` sobre lvalues
  nombrados, aunque parezcan estar en su último uso.
- Coordinar esta optimización con `ets::concat`, que ya calcula el tamaño total
  y reserva una sola vez.

## Verificación necesaria

- Pruebas semánticas que comparen el valor inicial antes y después de cada
  cadena, incluidos aliases y préstamos.
- Pruebas de codegen que distingan claramente receptores lvalue y rvalue.
- Un tipo instrumentado que cuente construcciones, copias, movimientos y
  destrucciones en pipelines de arrays.
- Benchmarks versionados para cadenas cortas y largas, registrando tiempo,
  asignaciones, bytes copiados y pico de memoria.
- Ejecución bajo ASan, UBSan y LeakSanitizer para detectar referencias colgantes
  o reutilización incorrecta de temporales.

## Criterio de finalización

La tarea se considera terminada cuando las pruebas demuestran que el valor
inicial permanece inmutable y los benchmarks muestran una reducción medible de
copias o asignaciones sin regresiones relevantes en cadenas pequeñas.
