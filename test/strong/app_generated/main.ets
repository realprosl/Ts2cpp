// V30.52: App que usa generadores de codigo cross-module.

import { genStaticVars, genForLoop, genCInclude } from "./generators.ets";

// Llamamos a los generadores. Cada uno emite codigo en compile-time.
// Las funciones @cppgen/@etsgen se filtran (V30.43) y no se emiten.

// 1) Genera 3 variables static int en C++.
genStaticVars();

// 2) Genera un for que imprime 0..2.
genForLoop(3);

// 3) Genera un include + printf.
genCInclude();

// 4) Verificacion: despues de los generadores, podemos usar las vars.
print("done");
