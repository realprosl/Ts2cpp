// nested-generics — encadenar Optionals.

const a: Optional<Optional<number>> = optionalSome<Optional<number>>(optionalSome<number>(42));
const b: Optional<Optional<number>> = optionalSome<Optional<number>>(optionalNone<number>());
const c: Optional<Optional<number>> = optionalNone<Optional<number>>();

const v1: number = optionalIsPresent(a) ? optionalValueOr(optionalValueOr(a, optionalNone<number>()), 0) : -1;
const v2: number = optionalIsPresent(b) ? optionalValueOr(optionalValueOr(b, optionalNone<number>()), 0) : -2;
const v3: number = optionalIsPresent(c) ? optionalValueOr(optionalValueOr(c, optionalNone<number>()), 0) : -3;

print(numberToString(v1));
print(numberToString(v2));
print(numberToString(v3));
