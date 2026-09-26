// Demo de `typeof` como valor: devuelve el nombre canónico del tipo del
// operando. El resultado siempre es un `string` literal en C++.
let x: number = 42;
print(typeof x);             // number
print(typeof "hi");          // string
print(typeof true);          // boolean
print(typeof [1, 2]);        // object
print(typeof print("yo"));   // undefined
