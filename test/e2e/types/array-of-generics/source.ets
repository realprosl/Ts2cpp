// array-of-generics — Optional<number> anidado en variables individuales.

const a: Optional<number> = optionalSome<number>(1);
const b: Optional<number> = optionalNone<number>();
const c: Optional<number> = optionalSome<number>(2);
const d: Optional<number> = optionalSome<number>(3);

let total: number = 0;
if (optionalIsPresent(a)) total = total + optionalValueOr(a, 0);
if (optionalIsPresent(b)) total = total + optionalValueOr(b, 0);
if (optionalIsPresent(c)) total = total + optionalValueOr(c, 0);
if (optionalIsPresent(d)) total = total + optionalValueOr(d, 0);

print(numberToString(total));
