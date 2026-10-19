# Ámbitos de `comptime`

El evaluador utiliza una cadena de ámbitos para distinguir una declaración
local de una asignación a un nombre exterior:

```ets
const result: number = comptime((): number => {
  let x: number = 10;
  let total: number = 0;
  if (true) {
    let x: number = 99;
    total += x;
  }
  return x + total; // 109, no 198
});
```

- Declarar `let` o `const` crea un binding en el bloque actual.
- Los nombres se reservan desde la entrada al bloque. Leerlos o escribirlos
  antes de ejecutar su declaración produce un diagnóstico de zona muerta
  temporal, en vez de acceder a un binding exterior con el mismo nombre.
- Asignar a un nombre existente actualiza el binding más cercano.
- El contador declarado en el inicializador de un `for` pertenece al bucle;
  no sobrescribe una variable homónima exterior ni queda disponible al salir.
- El cuerpo de un bucle abre un bloque nuevo en cada iteración.
- Los parámetros de callbacks son locales; los callbacks siguen pudiendo leer
  sus ámbitos padres y modificar un acumulador exterior.
- Un `return` dentro de bloques anidados se propaga hasta la función o arrow;
  los bloques intermedios no lo consumen.
- `break` termina únicamente el bucle más cercano; `continue` inicia su próxima
  iteración. En `for`, el incremento se ejecuta también tras un `continue`, pero
  no tras `break`. Son señales distintas de `return`.
- Un control de bucle que llega al límite de una función o callback sin haber
  sido consumido por un bucle produce un diagnóstico con el span original.

El recorrido del AST que prepara capturas también aísla los bloques y el ámbito
del `for`, para que las declaraciones interiores no contaminen los call sites
que vienen después.

## Pruebas y alcance

`test/unit/comptime-scopes.test.ts` contiene 21 regresiones que ejecutan el
evaluador directamente y comprueban también el pipeline del compilador. No
requieren libuv, un compilador C++ ni servicios externos; se incluyen en
`npm test`.

`test/unit/comptime-loop-control.test.ts` añade 16 regresiones de `break`,
`continue`, anidamiento, retorno y controles fuera de contexto. Un bucle infinito
con `continue` sigue agotando el presupuesto de instrucciones; este control no
permite eludir los límites del evaluador.

`test/unit/comptime-tdz.test.ts` añade 12 regresiones de zona muerta temporal:
lecturas, asignaciones simples y compuestas, inicialización propia,
destructuring, `for`, callbacks, funciones y orden de declaración top-level.

`test/unit/comptime-nested-captures.test.ts` añade ocho regresiones para
entradas anidadas: composición entre funciones decoradas, parámetros y locales
del caller, recursión, capturas globales, call sites independientes y
composición con `@cppgen`. Cada entrada guarda y restaura el ámbito capturado
anterior mediante `try/finally`.

Los fallos aplazables ya no se reconocen por el texto del mensaje. Un binding
que existe pero cuyo valor solo estará disponible en runtime emite el código
estructurado `COMPTIME_VALUE_UNAVAILABLE`; el visitor conserva entonces el AST
de la llamada. `test/unit/comptime-typed-errors.test.ts` verifica que TDZ,
división por cero y otros errores reales no entren en esa ruta.

El pipeline valida semánticamente el AST fuente antes de ejecutar `comptime` y
vuelve a validar el AST transformado. Así, un error dentro del arrow no puede
desaparecer al sustituir la llamada por su literal. La validación especial de
la llamada conserva el tipo de retorno del arrow, incluidos aliases.
`test/unit/comptime-semantic-order.test.ts` aporta siete regresiones de tipos
locales, mutabilidad, arrays, argumentos y callbacks; cinco fallaban antes.

Las llamadas sobrecargadas reutilizan la selección del checker mediante
WeakMaps, sin introducir referencias cíclicas en el AST. Esto incluye los
decoradores `@comptime`, `@cppgen` y `@etsgen`, que pertenecen a cada firma y no
solo al nombre de la función. Ver [`comptime-overloads.md`](./comptime-overloads.md).

El intérprete principal separa los presupuestos de evaluaciones raíz
independientes y de los intentos preliminares de resolver inicializadores.
Los helpers y callbacks anidados siguen compartiendo los límites del caller.
Ver [`comptime-budgets.md`](./comptime-budgets.md).

Los errores del intérprete conservan el span completo del nodo fuente; no
convierten offsets absolutos en columnas de línea cero. El loader remapea
archivo, líneas y offsets al texto correspondiente a cada módulo. Ver
[`comptime-diagnostics.md`](./comptime-diagnostics.md).

Estas correcciones no equivalen a una implementación completa de la semántica
de TypeScript. Los números utilizan valores JavaScript y la higiene entre
módulos es parcial.
Los controles de bucle con etiquetas todavía no están implementados.
