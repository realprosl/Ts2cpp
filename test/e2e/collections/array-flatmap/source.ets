// V30.8: `flatMap<U>(f)` aplica f (que devuelve array) y concatena 1 nivel.
let duplicados: number[] = [1, 2, 3].flatMap<number>((n: number): number[] => [n, n * 2]);
print(numberToString(length(duplicados)));   // 6
print(numberToString(duplicados[0]));        // 1
print(numberToString(duplicados[1]));        // 2
print(numberToString(duplicados[2]));        // 2
print(numberToString(duplicados[3]));        // 4
print(numberToString(duplicados[4]));        // 3
print(numberToString(duplicados[5]));        // 6
