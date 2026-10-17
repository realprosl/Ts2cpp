// V30.55: builtins de string que ahora emite el codegen.
// Caso real de uso: substring + indexOf + charAt + arr[i] = x.
// (substring con 2 args sigue siendo gap — V30.56. `as` cast con
// variant no genera conversion runtime todavia — V30.56.)
let s: string = "hello world";
let first: string = charAt(s, 0);
let idx: number = indexOf(s, "world", 0);
let sub: string = substring(s, 6, 11);

print(first);
print(numberToString(idx));
print(sub);

// V30.55: arr[i] = x con auto-resize.
let arr: number[] = [];
arr[0] = 100;
arr[3] = 300;
print(numberToString(length(arr)));
print(numberToString(arr[0]));
print(numberToString(arr[3]));

// V30.55: `as` cast narrowing basico (string[] sin variant — V30.56
// añadira conversion runtime para variants).
let words: string[] = ["foo", "bar", "baz"];
let w: string = words[0] as string;
print(w);
