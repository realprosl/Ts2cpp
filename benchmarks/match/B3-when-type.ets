// B3: match con whenType<T> sobre union (V23.2 narrowing via holds_alternative).
// El callback solo dispatcha (no usa el valor narrowed) para comparar
// apples-to-apples con std::visit en C++. Medimos overhead puro del
// dispatch sobre el variant.

let n: number = 0;
let s: number = 0;

function dispatch(v: number | string): void {
  match(v, [
    whenType<number>((): void => { n = n + 1; }),
    whenType<string>((): void => { s = s + 1; }),
  ]);
}

for (let i: number = 0; i < 1000000; i = i + 1) {
  if (i % 2 == 0) dispatch(i);
  else dispatch("x");
}
print(numberToString(n + s));
