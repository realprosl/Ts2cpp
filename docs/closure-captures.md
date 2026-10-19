# Capturas léxicas de closures

El checker registra las capturas durante la resolución semántica de cada uso,
en lugar de recorrer nombres del AST sin sus ámbitos. Compara la identidad
del símbolo resuelto con el símbolo visible en el punto de creación de cada
lambda activa. Solo las variables externas a esa lambda requieren captura.

Esto distingue parámetros y declaraciones interiores, sombreado de bloques,
bindings de bucle y locales homónimos de globales. Una llamada a un callback
local también registra el callee aunque su nombre esté almacenado en un
`CallExpression`, no en un `IdentifierExpression` separado.

Los usos interiores se propagan a las lambdas exteriores que necesitan
transportar ese mismo símbolo. Los globales reales no se capturan. El AST
conserva únicamente los nombres en `capturedSymbols`; los contextos y mapas
de símbolos del análisis no se serializan en el árbol.

## Mutabilidad y emisión

Las escrituras a capturas se propagan por los mismos contextos. Se incluye la
asignación compuesta (`+=`, etc.), que antes no marcaba mutación capturada.
El backend mantiene la política existente: captura por valor para lectura y
por referencia para closures con mutación capturada. En una lista explícita
de referencias cada nombre lleva `&`; `[&a, b]` no equivale a `[&a, &b]`.

Los nombres capturados pasan por el renombrado C++ del backend. No se elimina
una captura solo por llamarse `path`, `fs`, etc.: puede ser una variable local
que sombrea al namespace global.

## Comprobaciones y límites

Hay 16 regresiones nuevas; nueve fallan contra v24. Cinco compilan y ejecutan
C++20: pipelines inline anidados, sombreado y callbacks transitivos, mutación
anidada de dos capturas mediante `=` y `+=`, y retorno de una closure de solo
lectura cuyo valor permanece disponible después del retorno.

No se implementa análisis de escape completo ni lifetime parameters. La
protección parcial rechaza retornos de tipo función y arrays dinámicos de funciones con procedencia
conocida de capturas por referencia; ver
[`closure-return-safety.md`](closure-return-safety.md). No protege todos los
escapes: una closure por referencia no debe sobrevivir a sus locales y
guardarla en un callback asíncrono todavía puede dejar referencias colgantes. Las
restricciones existentes para `ref<T>` y `constRef<T>` siguen siendo
conservadoras. Tampoco se unifica aquí la política especial de captura de
`this` en métodos, ni se optimizan copias, movimientos o buffers. Estas pruebas
no certifican ausencia general de fugas ni seguridad concurrente.

Ejemplo reproducible (salida: `18`, `1`, `2`, `3`, en líneas separadas):

```bash
node --experimental-strip-types src/cli.ts examples/closure-captures/main.ets -o build/closure-captures.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/closure-captures.cpp -o build/closure-captures
./build/closure-captures
```
