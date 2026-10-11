// exhaustive-union: V30 con V23 intrinsics + discriminator sobre union.
// V30.5.2: el codegen ahora emite `r.kind == R_Kind::Success` (miembro
// del enum del union) en vez de `std::string("Success")`. Esto permite
// que el match compile out-of-the-box para tagged unions.

union R = Success(string) | Failure(number);

function f(r: R): string {
  return match(r, "kind", [
    when("Success", (v: R): string => "ok:yes"),
    when("Failure", (v: R): string => "err:7"),
    otherwise((): string => "?"),
  ]);
}

print(f(R.Success("yes")));
print(f(R.Failure(7)));
