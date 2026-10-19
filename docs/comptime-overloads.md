# Sobrecargas en evaluación estática

`compile` y `compileFile` validan primero el AST fuente. El checker guarda qué
declaración eligió para cada llamada; `comptime`, `@comptime`, `@cppgen` y el
mini-evaluador de `@etsgen` reutilizan esa selección.

```ts
function choose(n: number): number { return 11; }
function choose(n: string): number { return 99; }
const result: number = comptime((): number => choose(1)); // 11
```

Antes, un mapa por nombre descartaba todas las declaraciones menos la última,
por lo que el ejemplo producía `99`. Ahora se conservan todas las firmas y se
ejecuta la declaración elegida semánticamente. No se deducen tipos de los
valores JavaScript: un array vacío conserva la selección basada en su tipo
estático, no en sus elementos. También se respetan aliases, argumentos de tipo
y llamadas anidadas o recursivas que ya acepta el checker.

Los decoradores se comprueban en la firma seleccionada. Si solo una sobrecarga
tiene `@cppgen`, una llamada a otra firma runtime no se sustituye por C++.
La selección no ejecuta argumentos ni duplica sus efectos secundarios.

## API del evaluador

Las asociaciones se guardan en WeakMaps del checker, no como enlaces desde el
AST hacia sus declaraciones. Así se evitan ciclos durante recorridos y
serialización. Al usar el evaluador directamente:

```ts
const ast = parse(source);
const checker = new TypeChecker();
checker.check(ast);
const resolve = call => checker.functionOf(call);
const transformed = evaluateComptime(ast, undefined, resolve);
const generated = evalEtsgenCalls(transformed, resolve);
```

El resolver debe pertenecer al checker y a los nodos de ese mismo análisis;
no se puede reutilizar sobre un AST parseado de nuevo o serializado.
Sin resolver, una única declaración sigue funcionando como antes. Una llamada
sobrecargada que necesita evaluación emite `COMPTIME_OVERLOAD_UNRESOLVED`: no
se elige arbitrariamente por orden de declaración. Las llamadas runtime sin
decoradores no se evalúan por el mero hecho de estar sobrecargadas.

Esta corrección no amplía la ejecución de defaults, parámetros opcionales o
packs, ni unifica ambos intérpretes. Tampoco aísla símbolos homónimos de módulos
distintos: la protección `MODULE_SYMBOL_COLLISION` sigue siendo necesaria.

## Pruebas

`test/unit/comptime-overloads.test.ts` aporta 25 regresiones. En la primera
reproducción fallaban 17 de 19 casos; después se añadieron seis comprobaciones
de firmas independientes, decoradores mixtos, API con resolver y AST sin ciclos.

El ejemplo nativo cubre cinco resultados verificables:

```bash
mkdir -p build
node --experimental-strip-types src/cli.ts examples/comptime-overloads/main.ets -o build/comptime-overloads.cpp
g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions -I. build/comptime-overloads.cpp -o build/comptime-overloads
./build/comptime-overloads
```

Salida esperada, una línea por valor: `11`, `99`, `33`, `77`, `88`.
