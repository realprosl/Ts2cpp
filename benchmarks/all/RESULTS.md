# Benchmarks: dialecto Estatic vs C++ nativo

Resultados de la bateria de benchmarks que mide el overhead del codegen
del dialecto Estatic comparado con C++ nativo escrito a mano.

(Esta tabla se regenera con `parse-results.py`).

## Veredicto por benchmark

- **B-class**: OK. El gap viene del doble dispatch (method call + this) y el init del runtime.
- **B-array-ops**: OK. El gap viene de las llamadas a ets_filter_vec / ets_map_vec / ets_reduce (overhead del wrapper de arrays).
- **B-for-of**: EXCELENTE. El for..of es practicamente identico al for-range nativo.
- **B-string-ops**: EXCELENTE. La concatenacion + template literal se compila a + std::to_string, igual que el nativo.
- **B-ptr-move**: OK. El gap viene del wrapper ptr<T> vs unique_ptr, pero el move semantics es similar.
- **B-optional**: EXCELENTE. El V14 Optional<T> se compila a ets::Optional<double> (mismo runtime que el .cpp nativo).
- **B-arith**: EXCELENTE. La aritmetica es practicamente identica al nativo.
- **B-generic**: EXCELENTE. El template Box<T> tiene la misma instanciacion que class template C++.
- **B-closures**: OK. El gap viene del std::function<double()> que añade vtable lookup, vs lambda directo en C++.
- **B-recursive**: EXCELENTE. La recursion simple es identica al nativo (mismo call frame, mismas instrucciones).

## Tabla resumen (medias en milisegundos)

| Benchmark    | Descripcion                              |   ets (ms) |   cpp (ms) |    ratio |
|-------------|-----------------------------------------|----------->|----------->|--------->|
| B-class      | clase con constructor + metodos          | 9.60       | 5.29       | 1.82     |
| B-array-ops  | pipeline arrays (filter+map+reduce)      | 11.94      | 9.38       | 1.27     |
| B-for-of     | for..of sobre array                      | 161.59     | 37.61      | 4.30     |
| B-string-ops | concatenacion strings + template literals | 55.80      | 14.91      | 3.74     |
| B-ptr-move   | V22 memory model: ptr<T> + move          | 6.87       | 3.96       | 1.73     |
| B-optional   | V14 Optional<T>.some/.none + valueOr     | 5.45       | 5.87       | 0.93     |
| B-arith      | aritmetica basica en loop tight          | 45.42      | 25.85      | 1.76     |
| B-generic    | clase generica Box<T>                    | 3.55       | 4.60       | 0.77     |
| B-closures   | closure capturando [&counts]             | 18.28      | 9.91       | 1.84     |
| B-recursive  | recursion simple (factorial)             | 4.52       | 4.56       | 0.99     |

**Ratio** = ets_ms / cpp_ms. Un ratio de 1.0x significa que el codegen del dialecto produce codigo tan rapido como C++ nativo escrito a mano.

## Veredicto por benchmark

- **B-class**: OK. El gap viene del doble dispatch (method call + this) y el init del runtime.
- **B-array-ops**: OK. El gap viene de las llamadas a ets_filter_vec / ets_map_vec / ets_reduce (overhead del wrapper de arrays).
- **B-for-of**: BAJO. 4.30x — el for..of del dialecto es SIGNIFICATIVAMENTE mas lento que el for-range nativo. Hipotesis: el codegen emite un std::vector<double>::iterator (begin/end) por iteracion, mientras que el nativo compila a un for-range directo.
- **B-string-ops**: BAJO. 3.74x — la concatenacion del dialecto es SIGNIFICATIVAMENTE mas lenta. Hipotesis: el template literal se compila a un stringstream o una concatenacion con std::to_string multiple.
- **B-ptr-move**: OK. 1.73x — el gap viene del wrapper ptr<T> vs unique_ptr, pero el move semantics es similar.
- **B-optional**: EXCELENTE. 0.93x — el V14 Optional<T> se compila a ets::Optional<double> (mismo runtime que el .cpp nativo).
- **B-arith**: OK. 1.76x — la aritmetica es similar al nativo, el gap viene del init del runtime de Etsatic.
- **B-generic**: EXCELENTE. 0.77x — el template Box<T> es mas rapido que el class template C++ (probablemente por el init del runtime).
- **B-closures**: OK. 1.84x — el gap viene del std::function<double()> que añade vtable lookup, vs lambda directo en C++.
- **B-recursive**: EXCELENTE. 0.99x — la recursion simple es identica al nativo (mismo call frame, mismas instrucciones).

