// V1.4 — tests de narrowing de tagged unions.
// Validamos que el type-checker acepta acceso a campos de variantes
// narrowadas sin necesidad de cast explícito.

function getOrDefault(r: Result<number>, fallback: number): number {
  if (r.ok == true) {
    return r.value;
  } else {
    return fallback;
  }
}

function describe(r: Result<string>): string {
  if (r.ok == false) {
    return "err: " + r.error;
  } else {
    return "ok: " + r.value;
  }
}

const a: Result<number> = ok<number>(42);
const b: Result<number> = err<number>("nope");
print(getOrDefault(a, -1));
print(getOrDefault(b, -1));
print(describe(ok<string>("hi")));
print(describe(err<string>("bad")));
