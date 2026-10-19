# Presupuestos por evaluación raíz

El intérprete principal ya no acumula instrucciones, profundidad de llamadas y
estimación de valores entre constantes independientes de todo el programa.
Cada entrada raíz tiene presupuesto propio:

- una llamada `comptime(arrow)`;
- una llamada estática a una función `@comptime` o `@cppgen`;
- cada intento preliminar de calcular un inicializador top-level.

Las llamadas anidadas, la recursión y los callbacks forman parte de esa misma
evaluación. No reinician sus contadores: dividir un cálculo excesivo entre
helpers no permite eludir el límite.

Los contadores se inicializan al entrar en la raíz y se limpian mediante
`try/finally`, tanto si termina normalmente como si falla. Un intento
preliminar que agota instrucciones o profundidad ya no contamina la siguiente
constante. Los intentos preliminares continúan siendo especulativos: si no
pueden calcular el inicializador, no fuerzan su conversión a un literal.

Los límites por defecto del intérprete principal siguen siendo 10.000
instrucciones, profundidad 100 y 1 MiB de valores estimados. La API
`evaluateComptime(program, limits, resolver)` permite proporcionar otros límites.
Esto no añade configuración nueva al CLI.

## Qué no garantiza

`maxValueBytes` suma tamaños lógicos de valores inspeccionados dentro de una
raíz: ahora incluye payload UTF-8 de strings y claves, resultados y crecimiento
de colecciones. Puede volver a contar aliases y valores revisados, y no mide
memoria viva ni el RSS del compilador. Ver
[`comptime-values.md`](./comptime-values.md) para las reglas y puntos de control.

No hay un límite agregado de todas las raíces, constantes retenidas o tiempo
total de compilación. La política global de recursos sigue pendiente.

El mini-evaluador de `@etsgen` sigue separado. Ahora usa presupuestos propios
por generación, con límites de instrucciones, profundidad, valores y texto
generado; ver [`etsgen-limits.md`](./etsgen-limits.md). Unificar ambos
intérpretes sigue pendiente.

## Verificación

`test/unit/comptime-budgets.test.ts` contiene 16 regresiones. Diez fallan al
ejecutarlas contra v18. Comprueban evaluaciones independientes, contaminación
desde inicializadores, limpieza tras errores, límites anidados, bucles
infinitos, recursión excesiva y 100 constantes en el pipeline completo.

El ejemplo `examples/comptime-budgets/main.ets` ejecuta cuatro evaluaciones
estáticas independientes. Cada una cabe en el límite individual; su suma ya
no causa un error por un supuesto presupuesto compartido del programa.

```bash
mkdir -p build
node --experimental-strip-types src/cli.ts examples/comptime-budgets/main.ets -o build/comptime-budgets.cpp
g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions -I. build/comptime-budgets.cpp -o build/comptime-budgets
./build/comptime-budgets
```

Salida esperada y verificada: `1400`.
