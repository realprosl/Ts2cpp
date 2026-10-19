# Aliases bajo arrays anidados

La expansión de tipos desciende bajo todas las dimensiones de arrays dinámicos.
`type Scalar = number; Scalar[][]` se normaliza a `number[][]`, y el mismo
recorrido admite cadenas de aliases, aliases genéricos y aliases de funciones.
Los parámetros, retornos y declaraciones usan esa forma normalizada.

La ruta de aliases activos se comparte al descender; validar un elemento de
array conserva también esa ruta. Los ciclos directos e indirectos a través de
arrays producen un diagnóstico en lugar de un desbordamiento de pila. Los
aliases recursivos no se convierten en tipos recursivos válidos por esta mejora.

Hay 12 regresiones nuevas; 11 fallan contra v27. Incluyen comprobación de tipos
incompatibles, ciclos y E4210 para una closure peligrosa dentro de `Reader[][]`.
Una compila y ejecuta matrices numéricas y arrays anidados de lectores por valor.
El ejemplo imprime `4`, `8`, `8`:

```bash
node --experimental-strip-types src/cli.ts examples/nested-array-aliases/main.ets -o build/nested-array-aliases.cpp
g++ -std=c++20 -O2 -pthread -fno-exceptions -I. build/nested-array-aliases.cpp -o build/nested-array-aliases
./build/nested-array-aliases
```

No completa la normalización de tipos dentro de todos los contenedores ni la
auditoría de ciclos bajo todas las construcciones del sistema de tipos.
