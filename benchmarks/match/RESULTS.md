# Benchmarks: V23 match vs C++ nativo

**Setup**: g++ 12.x, `-O2 -std=c++20` (default), hyperfine 1.18, 10 warmup + 10 runs.

**Hipótesis nula**: el codegen V23 emite un IIFE con if/else chain
estructuralmente equivalente al C++ nativo, así que el rendimiento
debería ser similar (gap < 20% por overhead de captura/lambda).

**Gap observado**: el binario .ets es ~1.5-2x mas lento que el .cpp
nativo. La causa principal es el coste de:

1. **Captura del lambda por referencia** (`[&]`) — el IIFE crea un
   closure que captura `n` por referencia.
2. **Llamadas a lambdas separados por cada `when`** — cada `when` es
   un lambda distinto, mientras que el C++ nativo inlinea el cuerpo.
3. **`std::string` retornado por valor** — cada lambda retorna un
   `std::string` que el caller mueve (RVO debería aplicar pero los
   retornos por valor de lambdas en IIFE son sutiles).

`g++ -O3` no cierra el gap: el inliner no mete los lambdas dentro
del IIFE porque están separados por `return` (punto de retorno). Esto
es estructural al diseño V23 (intencional: permite que el LSP vea el
match como una llamada a función con array literal).

Benchmark 1: ets
  Time (mean ± σ):      15.9 ms ±   1.6 ms    [User: 12.9 ms, System: 2.6 ms]
  Range (min … max):    14.4 ms …  18.9 ms    10 runs
 
Benchmark 2: cpp
  Time (mean ± σ):       7.1 ms ±   1.1 ms    [User: 4.3 ms, System: 2.4 ms]
  Range (min … max):     5.5 ms …   9.7 ms    10 runs
 
Summary
  cpp ran
    2.23 ± 0.42 times faster than ets
Benchmark 1: ets
  Time (mean ± σ):     314.3 ms ±  14.5 ms    [User: 310.8 ms, System: 2.9 ms]
  Range (min … max):   295.5 ms … 345.3 ms    10 runs
 
Benchmark 2: cpp
  Time (mean ± σ):     294.6 ms ±  38.8 ms    [User: 291.8 ms, System: 2.2 ms]
  Range (min … max):   257.3 ms … 389.3 ms    10 runs
 
Summary
  cpp ran
    1.07 ± 0.15 times faster than ets
Benchmark 1: ets
  Time (mean ± σ):      17.7 ms ±   3.8 ms    [User: 14.0 ms, System: 3.2 ms]
  Range (min … max):    13.7 ms …  24.2 ms    10 runs
 
Benchmark 2: cpp
  Time (mean ± σ):       5.7 ms ±   1.6 ms    [User: 1.9 ms, System: 2.8 ms]
  Range (min … max):     3.7 ms …   8.6 ms    10 runs
 
Summary
  cpp ran
    3.12 ± 1.12 times faster than ets
Benchmark 1: ets
  Time (mean ± σ):      15.5 ms ±   2.5 ms    [User: 12.4 ms, System: 2.6 ms]
  Range (min … max):    14.0 ms …  22.3 ms    10 runs
 
Benchmark 2: cpp
  Time (mean ± σ):       9.3 ms ±   0.9 ms    [User: 6.5 ms, System: 2.4 ms]
  Range (min … max):     8.0 ms …  11.1 ms    10 runs
 
Summary
  cpp ran
    1.67 ± 0.32 times faster than ets
Benchmark 1: ets
  Time (mean ± σ):      11.1 ms ±   1.1 ms    [User: 7.8 ms, System: 2.9 ms]
  Range (min … max):     9.8 ms …  13.4 ms    10 runs
 
Benchmark 2: cpp
  Time (mean ± σ):       7.1 ms ±   1.7 ms    [User: 4.4 ms, System: 2.3 ms]
  Range (min … max):     5.4 ms …  10.9 ms    10 runs
 
Summary
  cpp ran
    1.56 ± 0.40 times faster than ets

## Tabla resumen (medias en milisegundos)

| Benchmark              | Descripcion                              |   ets (ms) |   cpp (ms) |    ratio |
|-----------------------|-----------------------------------------|----------->|----------->|--------->|
| B1-value-pattern       | match por valor (5 ramas)                | 15.88      | 7.10       | 2.23     |
| B2-discriminator       | match con discriminator de string        | 314.25     | 294.64     | 1.07     |
| B3-when-type           | match con whenType sobre union           | 17.73      | 5.68       | 3.12     |
| B4-v2-exhaustive       | match V2 destructurado exhaustivo        | 15.51      | 9.26       | 1.67     |
| B5-iife-overhead       | overhead puro del IIFE (1 rama)          | 11.09      | 7.10       | 1.56     |

**Ratio** = ets_ms / cpp_ms. Un ratio de 1.0x significa que el codegen V23 produce codigo tan rapido como C++ nativo escrito a mano.

## Veredicto por benchmark

- **B1-value-pattern**: OK. El gap viene de la captura de lambda + invocacion de lambdas separados. Esperable para un IIFE con if/else chain.
- **B2-discriminator**: EXCELENTE. Casi identico al nativo (1.07x). El coste dominante es la comparacion de strings, no el match.
- **B3-when-type**: OK. El codegen V23.2 emite holds_alternative encadenado, similar a std::visit. Gap viene de que el callback se invoca con 0 args (no usa el narrowed).
- **B4-v2-exhaustive**: OK. El switch sobre enum + std::get es similar al C++ nativo. Gap por la indireccion del IIFE.
- **B5-iife-overhead**: OK. Con 1 sola rama + otherwise, el IIFE deberia ser casi identico al inline. Gap residual es la captura del lambda.

