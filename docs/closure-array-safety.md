# Procedencia de closures en arrays dinámicos

La protección parcial `CLOSURE_REFERENCE_RETURN` (`E4210`) sigue la procedencia
de closures a través de arrays dinámicos, además de valores de tipo función.
Un array con una closure conocida por capturar locales por referencia no puede
retornarse por las rutas modeladas. Extraer la closure tampoco elimina su riesgo.

Se modelan literales y spread, aliases de variables, `push`, asignaciones a
índices sobre variables array, extracción por índice, destructuring de arrays
y bindings `for..of`. Los métodos de arrays cuyo resultado puede transportar
closures propagan conservadoramente receptor y argumentos: cubre, entre otros,
`slice`, `filter` y `concat`. Las llamadas libres que devuelven arrays de
funciones también propagan sus argumentos, sin resumen interprocedural.

El grafo no distingue índices ni orden de escrituras: sobrescribir una celda
con una closure segura no elimina el riesgo previo. Los callbacks de métodos
pueden añadir falsos positivos si su referencia no queda realmente retenida
en el resultado. No se afirma precisión por elemento ni por rama.

Los resultados de tipo `number[]`, por ejemplo, no se marcan como portadores
de closures solo porque el callback de `map` mute un local. No se cambia la
política de copia/movimiento del runtime ni se reutilizan buffers.

La revisión también corrige `push`: valida el tipo del argumento, recorre su
expresión y registra mutación de estado capturado. Esto no completa la auditoría
del contrato de mutabilidad de todos los métodos o receptores `const`.

## Límites restantes

- No cubre campos de objetos, clases, mapas, sets, uniones ni retornos
  envueltos en `Promise`, ni demuestra seguridad de tuples/arrays fijos.
- No modela todas las modificaciones indirectas a un array, los efectos de
  funciones que reciben el contenedor ni aliases mediante punteros/préstamos.
- No bloquea todavía almacenamiento en globales ni callbacks asíncronos o
  retenidos. Tampoco proporciona lifetimes completos ni seguridad concurrente.
- Los aliases bajo arrays dinámicos anidados, incluido `Reader[][]`, se
  normalizan desde v28; ver [`nested-array-aliases.md`](nested-array-aliases.md).
  No se afirma normalización completa dentro de todas las construcciones.
- Sigue siendo una protección parcial: ausencia de E4210 no certifica ausencia
  de referencias colgantes ni fugas.

Hay 17 regresiones nuevas. Quince fallan contra v26; una prueba compila y ejecuta
C++20 para comprobar que un array de lectores capturados por valor sigue siendo
válido tras retornar su fábrica.

Ejemplo reproducible (salida `8`, `8`, en líneas separadas):

```bash
node --experimental-strip-types src/cli.ts examples/closure-array-safety/main.ets -o build/closure-array-safety.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/closure-array-safety.cpp -o build/closure-array-safety
./build/closure-array-safety
```
