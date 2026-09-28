// V2 — Pattern matching exhaustivo sobre tagged unions.
// Sintaxis: `case { kind: "Variant", <bindings> }: <expr>;` con wildcard
// `case _: <expr>;` opcional. El compilador verifica en compilación que
// TODAS las variantes están cubiertas (o que hay un wildcard).

union FileError = NotFound(string) | PermissionDenied | IOError(string);

function describe(err: FileError): string {
  return match (err) {
    case { kind: "NotFound", path }: "missing: " + path;
    case { kind: "PermissionDenied" }: "denied";
    case { kind: "IOError", message }: "io: " + message;
  };
}

// Variante nula + wildcard: cualquier variante no listada cae al `_`.
union Shape = Circle | Square | Triangle;
function name(s: Shape): string {
  return match (s) {
    case { kind: "Circle" }: "circle";
    case _: "other";
  };
}

// Resultado numérico: `match` con uniones también vale para expresiones
// aritméticas. El tipo del match es el tipo del primer arm.
function radius(s: Shape): number {
  return match (s) {
    case { kind: "Circle" }: 1.0;
    case { kind: "Square" }: 1.41421356;
    case { kind: "Triangle" }: 0.5;
  };
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