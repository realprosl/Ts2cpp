// V30.52: Generadores de codigo @cppgen y @etsgen.

// @cppgen: genera codigo C++ literal.
// Declara 3 variables C++ estaticas con valores comptime-evaluados.
@cppgen
export function genStaticVars(): string {
  return "static int counter = 0;\nstatic int maxCount = 100;\nstatic int step = 5;";
}

// @etsgen: genera codigo del dialecto que se compila a C++.
// Genera un for que itera de 0 a n-1, imprimiendo cada valor.
@etsgen
export function genForLoop(n: number): string {
  return "for (let i: number = 0; i < " + n + "; i += 1) { print(numberToString(i)); }";
}

// @cppgen: genera un bloque C++ que no se puede expresar en el dialecto.
// Usa un #include de cstdio y un printf.
@cppgen
export function genCInclude(): string {
  return "#include <cstdio>\nprintf(\"hello from cppgen\\n\");";
}
