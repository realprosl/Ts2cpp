// V30.53: Generadores de codigo.
// Demuestra @cppgen y @etsgen cross-module.

// @cppgen: genera el header de la tabla en C++ literal.
// Se inyecta tal cual en el output.
@cppgen
export function genTableHeader(): string {
  return "// ========================================\n// TODO LIST\n// ========================================";
}

// @etsgen: genera el codigo que imprime el header de las columnas.
// Se compila como codigo del dialecto.
@etsgen
export function genColumnHeader(): string {
  return "print(\"ID  PRIO  STATUS  TEXT\");\n  print(\"--  ----  ------  ----\")";
}
