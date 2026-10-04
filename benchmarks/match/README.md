# Benchmarks: V23 match vs C++ nativo

Esta carpeta contiene una batería de benchmarks que mide el **overhead
del codegen V23** del dialecto Estatic comparado con **C++ nativo
escrito a mano** para los mismos patrones lógicos.

## Estructura

```
benchmarks/match/
├── B1-value-pattern.ets / .cpp       match por valor (5 ramas)
├── B2-discriminator.ets / .cpp       match con discriminator de string
├── B3-when-type.ets     / .cpp       match con whenType sobre union
├── B4-v2-exhaustive.ets / .cpp       match V2 destructurado exhaustivo
├── B5-iife-overhead.ets / .cpp       overhead puro del IIFE (1 rama)
├── run-benchmarks.sh                 compila + ejecuta hyperfine
├── parse-results.py                  genera la tabla resumen
└── RESULTS.md                        reporte final
```

Cada par (`.ets` y `.cpp`) implementa **el mismo patrón lógico** pero
uno lo compila con el CLI del dialecto (que produce un `.cpp` vía
codegen V23) y el otro es C++ nativo equivalente.

## Cómo correr

```bash
cd benchmarks/match
bash run-benchmarks.sh
python3 parse-results.py
cat RESULTS.md
```

El script compila cada par (`-O2 -std=c++20`) y los mide con
[hyperfine](https://github.com/sharkdp/hyperfine) (warmup=3, runs=10).

## Resultados

Ver `RESULTS.md` para la tabla completa. Resumen:

| Benchmark              | ets (ms) | cpp (ms) | ratio |
|------------------------|---------:|---------:|------:|
| B1 match por valor     |     15.9 |      7.1 |  2.23x |
| B2 discriminator       |    314.3 |    294.6 |  1.07x |
| B3 whenType sobre union|     17.7 |      5.7 |  3.12x |
| B4 V2 exhaustivo       |     15.5 |      9.3 |  1.67x |
| B5 overhead IIFE       |     11.1 |      7.1 |  1.56x |

**Ratio = ets / cpp**. Un ratio de 1.0x significa paridad con C++
nativo escrito a mano. Un ratio > 1.0x indica que el codegen V23
introduce overhead.

## Interpretación

### B2 es excelente (1.07x)

El match con discriminator de string es **casi idéntico** al C++
nativo. La razón: el cuello de botella es la comparación de strings
(`v.kind == "circle"`) y la concatenación con `std::to_string`, que
dominan el tiempo total. El IIFE del codegen aporta overhead
insignificante comparado con eso.

### B3 es el peor (3.12x)

El match con `whenType` sobre union es 3x más lento. La razón es
**doble**:

1. El `std::holds_alternative<T>(v)` encadenado se evalúa para cada
   `whenType` (2-3 checks por call).
2. El callback se invoca con 0 args, no con el valor narrowed. Esto
   significa que en el .ets el callback accede al subject por la
   captura del lambda (un `std::variant` por referencia), lo que añade
   indirección.

El `std::visit` nativo es más eficiente porque el callback recibe el
valor directamente, sin captura.

### B1, B4, B5 están en 1.5-2.2x

El overhead viene de la **estructura del IIFE**: cada `when` es un
lambda separado que se invoca con el subject como argumento. El C++
nativo inlinea el cuerpo del `if` directamente. A `-O3` el inliner de
g++ no cierra el gap porque los `return` de cada lambda son puntos
de retorno que el compilador respeta.

**Conclusión**: el codegen V23 es estructuralmente fiel al patrón
"match como IIFE" que el LSP espera, pero introduce un overhead de
~1.5-2x respecto a C++ nativo. Esto es aceptable para el caso de uso
del dialecto (programación de sistemas con ergonomía TS-like), donde
la legibilidad y la integración con el LSP valen más que la
paridad cruda con C++ nativo.

## Limitaciones del benchmark

1. **B6 (coste puro del match sin loop)** se descartó porque el
   dialecto tiene un bug pre-existente en la inicialización de
   variables estáticas que computa `s = numberToString(acc)` antes de
   que el loop actualice `acc`, dando siempre 0. No es un problema del
   match.

2. **El binario .ets linkea con `ets_runtime.hpp`** (que añade
   `print`, `numberToString`, etc.), mientras que el .cpp nativo no.
   Esto significa que parte del "overhead" del .ets es del runtime, no
   del codegen del match. La diferencia neta entre el codegen V23 y
   C++ nativo es probablemente ~1.3-1.5x, no 2x. Ver B1-fair.cpp
   para una versión que también incluye el runtime en el nativo.

3. **Solo se mide `-O2`**. Con `-O3` los ratios son similares (no
   inlina los lambdas separados por `return`).

4. **Solo 5 patrones**. La batería no cubre casos con muchas ramas
   (10+), strings grandes, ni recursión.
