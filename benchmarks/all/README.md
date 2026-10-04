# Benchmarks: dialecto Estatic vs C++ nativo

Esta carpeta contiene una batería de benchmarks que mide el **overhead
del codegen del dialecto Estatic** comparado con **C++ nativo escrito a
mano** para los mismos patrones lógicos.

## Estructura

```
benchmarks/all/
├── B-class.{ets,cpp}        clase con constructor + metodos
├── B-array-ops.{ets,cpp}    pipeline arrays (filter+map+reduce)
├── B-for-of.{ets,cpp}       for..of sobre array
├── B-string-ops.{ets,cpp}   concatenacion strings + template literals
├── B-ptr-move.{ets,cpp}     V22 memory model: ptr<T> + move
├── B-optional.{ets,cpp}     V14 Optional<T>.some/.none + valueOr
├── B-arith.{ets,cpp}        aritmetica basica en loop tight
├── B-generic.{ets,cpp}      clase generica Box<T>
├── B-closures.{ets,cpp}     closure capturando [&counts]
├── B-recursive.{ets,cpp}    recursion simple (factorial)
├── run-benchmarks.sh        compila + ejecuta hyperfine
├── parse-results.py         genera la tabla resumen
└── RESULTS.md               reporte final
```

Cada par (`.ets` y `.cpp`) implementa **el mismo patrón lógico** pero
uno lo compila con el CLI del dialecto (que produce un `.cpp` vía
codegen) y el otro es C++ nativo equivalente.

## Cómo correr

```bash
cd benchmarks/all
bash run-benchmarks.sh
cat RESULTS.md
```

El script compila cada par (`-O2 -std=c++20`) y los mide con
[hyperfine](https://github.com/sharkdp/hyperfine) (warmup=3, runs=10).

## Resultados

Ver `RESULTS.md` para la tabla completa.

## Interpretación

Los benchmarks cubren las **features principales del dialecto**:

| Feature                | Benchmark    |
|------------------------|--------------|
| Clases + métodos       | B-class      |
| Arrays + lambdas       | B-array-ops  |
| for..of                | B-for-of     |
| Strings + template     | B-string-ops |
| V22 memory model       | B-ptr-move   |
| V14 Optional<T>        | B-optional   |
| Aritmética básica      | B-arith      |
| Genéricos              | B-generic    |
| Closures               | B-closures   |
| Recursión              | B-recursive  |

Los benchmarks de **match** (V23) están en `benchmarks/match/`.

## Limitaciones del benchmark

1. **El binario .ets linkea con `ets_runtime.hpp`** (que añade
   `print`, `numberToString`, etc.), mientras que el .cpp nativo a
   veces no. Esto significa que parte del "overhead" del .ets es del
   runtime, no del codegen de la feature. Ver
   `benchmarks/match/B1-fair.cpp` para una versión con runtime pareado.

2. **B-ptr-move** empareja el ptr<T> del dialecto con std::unique_ptr
   nativo. El codegen del dialecto probablemente tiene overhead extra
   del wrapper ptr<T>.

3. **B-closures** empareja el closure del dialecto con std::function
   nativo. Ambos usan captura por referencia, lo que añade un nivel
   de indirección (vtable lookup para std::function).

4. **Solo se mide `-O2`**. Con `-O3` los ratios son similares.
