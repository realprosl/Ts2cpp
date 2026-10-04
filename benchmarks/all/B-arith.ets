// B-arith: aritmetica basica en loop tight. Mide el coste de la
// aritmetica del dialecto (modelada como double, con static_cast
// para los tipos numericos concretos).

let acc: number = 0;
for (let i: number = 0; i < 10000000; i = i + 1) {
  acc = acc + i * 1.5 - i / 3 + i * i;
}

print(numberToString(acc));
