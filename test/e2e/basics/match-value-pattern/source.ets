function classify(n: number): string {
  return match(n, [
    when(0, (v: number): string => "cero"),
    when(1, (v: number): string => "uno"),
    when(2, (v: number): string => "dos"),
    otherwise((): string => "otro"),
  ]);
}

print(classify(0));
print(classify(1));
print(classify(2));
print(classify(42));
