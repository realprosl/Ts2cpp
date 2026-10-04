// exhaustive-union: V2 destructurado con union tipada. Verifica que la
// forma V2 (la unica con enforcement de exhaustividad) sigue funcionando
// intacta despues de la migracion V23.
union R = Success(string) | Failure(number);

function f(r: R): string {
  return match (r) {
    case { kind: "Success", s }: "ok:" + s;
    case { kind: "Failure", n }: "err:" + numberToString(n);
  };
}

print(f(R.Success("yes")));
print(f(R.Failure(7)));
