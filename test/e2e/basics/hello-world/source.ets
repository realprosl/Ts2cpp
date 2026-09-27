// hello-world — primer test E2E del proyecto.
//
// Verifica que un programa trivial se transpila, compila y ejecuta
// produciendo el stdout esperado. Sirve como smoke test del harness
// E2E completo (Issue #7).

function greet(name: string): void {
  print("hello, " + name + "!");
}

greet("world");
greet("e2e");
