// satisfies-object — `satisfies` no aplica a object literal en este dialecto.
// En su lugar demostramos satisfies sobre un valor primitivo y verificamos
// que no falla en runtime (es type assertion, sin efecto).

const x: number = 42 satisfies number;

print(numberToString(x));
