// V30.8: `slice(start, end)` devuelve un sub-array desde start (inclusivo)
// hasta end (exclusivo). Indices negativos cuentan desde el final.
let copia: number[] = [10, 20, 30, 40, 50].slice(1, 4);
print(numberToString(copia[0]));   // 20
print(numberToString(copia[1]));   // 30
print(numberToString(copia[2]));   // 40
