# Límites del mini-evaluador de `@etsgen`

`evalEtsgenCalls` mantiene su evaluador reducido, pero ya no permite recursión
estática sin límite ni parsea texto generado de tamaño arbitrario. Cada
generación raíz tiene contadores independientes; sus llamadas y expresiones
anidadas comparten el presupuesto. Se limpian con `try/finally`, incluso al
fallar. La evaluación preliminar de cada inicializador binario global también
tiene su propio presupuesto; un error de límite se propaga.

| Opción | Valor por defecto | Qué limita |
|---|---|---|
| `maxInstructions` | 10.000 | Expresiones evaluadas |
| `maxRecursion` | 100 | Profundidad de expresiones, incluidas llamadas anidadas |
| `maxValueBytes` | 1 MiB | Cargo acumulativo de valores inspeccionados |
| `maxGeneratedBytes` | 1 MiB | Texto del dialecto generado, en UTF-8, antes del parseo |

Los valores usan ocho bytes lógicos más el payload UTF-8 de strings. Las
concatenaciones y templates comprueban el tamaño por partes antes de construir
el resultado; la expresión factura después ese resultado. Los argumentos
literales se comprueban al vincularlos y las capturas globales al leerlas.
No se mide memoria viva ni se reembolsa presupuesto al abandonar un valor.

El límite de profundidad es más conservador que un contador exclusivo de
llamadas: también evita recursión excesiva del walker sobre expresiones. Una
función puede agotar el límite por la forma del AST, no solo por llamarse a sí
misma.

## Configuración y errores

La API admite opciones parciales sin cambiar el resolver de sobrecargas:

```ts
evalEtsgenCalls(ast, resolveFunction, {
  maxInstructions: 5000,
  maxRecursion: 50,
  maxValueBytes: 256 * 1024,
  maxGeneratedBytes: 64 * 1024,
});
```

`compile` y `compileFile` utilizan los defaults. No se añade configuración al
CLI. Las opciones se copian y deben ser enteros seguros no negativos; cero es
un límite válido, no una forma de desactivarlo.

Los diagnósticos conservan el span fuente y usan códigos estables:

- `ETSGEN_INSTRUCTION_LIMIT`.
- `ETSGEN_RECURSION_LIMIT`.
- `ETSGEN_VALUE_LIMIT`.
- `ETSGEN_GENERATED_LIMIT`.
- `ETSGEN_INVALID_LIMIT`.

Agotar un límite es fatal, no un motivo para dejar silenciosamente la llamada
en runtime. Los cuerpos o argumentos que el mini-evaluador no soporta siguen
conservando el fallback previo; esta entrega no amplía su sintaxis ni sus
garantías runtime.

El texto que sí se genera ahora pasa validación semántica en el contexto de la
llamada y se emite usando tipos reales. Ver
[`etsgen-semantics.md`](./etsgen-semantics.md).

## Alcance pendiente

El límite del texto se aplica antes de envolverlo y parsearlo. No limita el
tamaño del C++ resultante, todo el trabajo interno del parser/codegen, el AST
fuente ya construido, el tiempo total de compilación ni la suma de muchas
raíces independientes. Las expansiones recursivas de una misma raíz sí
acumulan bytes y cantidad de expansiones; ver `etsgen-hygiene.md`.
La higiene de bindings no unifica el mini-evaluador con el intérprete principal. Subir los límites excesivamente puede
superar recursos del motor JavaScript: no es un sandbox ni un límite duro de
RSS o tiempo de CPU.

## Verificación

`test/unit/etsgen-limits.test.ts` aporta 20 regresiones; 16 fallan contra v21.
Incluye recursión directa/mutua, profundidad de expresiones, instrucciones,
payload UTF-8, texto inválido excesivo rechazado antes del parseo, opciones
inválidas, capturas, raíces independientes y fallback sin cambios.

Ejemplo nativo verificado:

```bash
mkdir -p build
node --experimental-strip-types src/cli.ts examples/etsgen-limits/main.ets -o build/etsgen-limits.cpp
g++ -std=c++20 -O2 -DNDEBUG -pthread -fno-exceptions -I. build/etsgen-limits.cpp -o build/etsgen-limits
./build/etsgen-limits
```

Salida esperada: `7` y `8`, en líneas separadas.
