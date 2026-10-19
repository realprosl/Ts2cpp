# Protección parcial de retornos de closures

El diagnóstico `CLOSURE_REFERENCE_RETURN` (`E4210`) rechaza un retorno de
tipo función o array dinámico de funciones cuando su procedencia conocida incluye una closure que el
backend captura por referencia. No añade heap compartido ni cambia la
semántica de captura para hacer que una closure sobreviva automáticamente.

```ets
function unsafe(): () => number {
  let value: number = 0;
  const increment: () => number = (): number => { value += 1; return value; };
  return increment; // E4210: value dejaría de existir al retornar.
}
```

Las closures de solo lectura por valor, la mutación de globales reales y la
invocación local de una closure mutable siguen permitidas.

## Análisis implementado

Durante el chequeo se construye un grafo independiente del AST, con símbolos
resueltos por identidad. Enlaza inicializadores de variables simples, usos,
asignaciones a identificadores, alternativas condicionales y capturas de
otras closures. Las lambdas con mutación capturada son los orígenes de riesgo.

Los retornos explícitos y los implícitos de arrows se comprueban cuando el
valor tiene tipo función o array dinámico de funciones. Si una llamada devuelve uno de estos valores, se propaga
conservadoramente la procedencia de su callee local y sus argumentos. No se
inspecciona si el cuerpo del callee descarta el argumento: puede haber falsos
positivos. No son resúmenes interprocedurales de efectos o lifetimes.

Una worklist propaga riesgo hasta un punto fijo, sin recursión sobre aliases
y terminando también con ciclos. El análisis es insensible al orden y a las
ramas: una reasignación posterior a un valor seguro no borra el riesgo anterior,
y una rama imposible puede bastar para rechazar el retorno. Esto prioriza una
protección conservadora en las rutas modeladas frente a aceptar más programas.

El diagnóstico principal señala el retorno; incluye nombres y origen de la
captura como notas. El flujo modular conserva archivo y posición del error
principal. El grafo no se añade al AST ni a su serialización.

## Límites: no es escape analysis completo

- Solo se protegen retornos de tipo función y arrays dinámicos con la
  procedencia modelada. La ampliación v27 sigue literales, push, índices,
  destructuring y otras rutas descritas en
  [`closure-array-safety.md`](closure-array-safety.md). No se rastrean closures
  ocultas en campos, mapas, uniones u otros contenedores devueltos.
- No se bloquea todavía guardar una closure en globales/objetos, transferirla
  a una tarea asíncrona o pasarla a una función que retiene callbacks.
- Los parámetros de tipo función sin procedencia conocida se aceptan. El
  checker no demuestra el lifetime del callback recibido desde otro entorno.
- No se modelan accesos indirectos a memoria, código C++ opaco, todas las
  variantes de `this`, ni todas las llamadas a métodos que devuelven closures.
- No se demuestra seguridad de concurrencia ni ausencia de fugas. Fuera de
  estas rutas todavía pueden existir referencias colgantes.

Hay 19 regresiones nuevas; 13 fallan contra v25. Cubren aliases, ciclos,
reasignación, sombreado, capturas transitivas, retorno implícito, la API directa
del checker y diagnósticos modulares. Una prueba compila y ejecuta C++20 para
comprobar que siguen funcionando mutaciones locales y lectores devueltos.

Ejemplo reproducible (salida `1`, `2`, `2`, `8`, `8`, en líneas separadas):

```bash
node --experimental-strip-types src/cli.ts examples/closure-return-safety/main.ets -o build/closure-return-safety.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/closure-return-safety.cpp -o build/closure-return-safety
./build/closure-return-safety
```
