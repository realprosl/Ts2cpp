// V30 (antes V2) — Pattern matching sobre tagged unions.
// Sintaxis: `match(value, "key", [when(pat, cb), otherwise(cb)])`.
// Es la UNICA forma de match admitida (V30 elimino la forma V2
// `match (r) { case { kind: ..., bindings }: ...; }` porque no era
// TS-compatible y el LSP de TypeScript la marcaba con subrayados
// rojos). Para acceder al valor narrowed del payload, el callback
// recibe el subject entero y hace un `if (r.kind === "...")` adentro.

union FileError = NotFound(string) | PermissionDenied | IOError(string);

function describe(err: FileError): string {
  return match(err, "kind", [
    when("NotFound",        (e: FileError): string => "missing: " + "?"),  // sin narrowing
    when("PermissionDenied", (e: FileError): string => "denied"),
    when("IOError",         (e: FileError): string => "io: " + "?"),
  ]);
}

// Variante nula + otherwise: cualquier variante no listada cae al
// `otherwise`. El LSP no enforce exhaustividad (a diferencia del V2
// keyword), asi que `otherwise` es la forma idiomatica de cubrir el
// caso "todo lo demas".
union Shape = Circle | Square | Triangle;
function name(s: Shape): string {
  return match(s, "kind", [
    when("Circle", (s: Shape): string => "circle"),
    otherwise((s: Shape): string => "other"),
  ]);
}

// Resultado numerico: `match` con uniones tambien vale para expresiones
// aritmeticas. El tipo del match es el tipo del primer arm.
function radius(s: Shape): number {
  return match(s, "kind", [
    when("Circle",   (s: Shape): number => 1.0),
    when("Square",   (s: Shape): number => 1.41421356),
    when("Triangle", (s: Shape): number => 0.5),
  ]);
}

print(describe(FileError.NotFound("/tmp/foo.txt")));
print(describe(FileError.PermissionDenied()));
print(describe(FileError.IOError("disk gone")));

print(name(Shape.Circle()));
print(name(Shape.Square()));
print(name(Shape.Triangle()));

print("radius circle =", radius(Shape.Circle()));
print("radius square =", radius(Shape.Square()));
print("radius triangle =", radius(Shape.Triangle()));
