// optional-basic — Optional<T> con some/none/isPresent/valueOr.

const a: Optional<number> = optionalSome<number>(42);
const b: Optional<number> = optionalNone<number>();

print(numberToString(optionalValueOr(a, -1)));
print(numberToString(optionalValueOr(b, -1)));
print(numberToString(optionalIsPresent(a) ? 1 : 0));
print(numberToString(optionalIsPresent(b) ? 1 : 0));
