// constructor-demo.ets — Bloque 1: constructores en clases.
//
// Sintaxis: dentro de una clase, `constructor(params) { cuerpo }` define un
// constructor. No lleva tipo de retorno explícito (siempre es void). El
// cuerpo puede asignar a campos, incluyendo los declarados `readonly`.
//
// Reglas:
//   - Una clase puede tener un solo constructor (no hay overloading).
//   - Los campos `readonly` se pueden asignar SOLO dentro del constructor.
//     Fuera de él, el semantic checker rechaza la asignación con un
//     diagnóstico claro.
//   - Si la clase NO tiene constructor, los campos `readonly` se inicializan
//     aggregate-style: `T{valor}` en el call site `new T(...)`.

// Constructor simple: asigna campos mutables y readonly.
class Point {
  readonly x: number;
  readonly y: number;
  label: string;
  constructor(x: number, y: number, label: string) {
    this.x = x;
    this.y = y;
    this.label = label;
  }
  sum(): number { return this.x + this.y; }
}

let p: Point = new Point(3, 4, "origin");
print(p.sum());          // 7
print(p.label);          // origin
print(p.x);              // 3
print(p.y);              // 4

// Campos mutables se pueden modificar fuera del constructor.
p.label = "moved";
print(p.label);          // moved

// Sin constructor: aggregate init con `T{args}`.
class Pair {
  first: number;
  second: number;
}
const pair: Pair = new Pair(10, 20);
print(pair.first);       // 10
print(pair.second);      // 20

// Constructor con un solo parámetro, métodos de lectura y mutación externa.
class Counter {
  value: number;
  constructor(initial: number) { this.value = initial; }
  current(): number { return this.value; }
}

// V22: `mut` se reemplazó por `ref<T>` (T&). Ver examples/mut-demo.ets
// para la versión expandida. Aquí usamos la misma forma compacta.
function increment(counter: ref<Counter>): void {
  counter.value = counter.value + 1;
}

let c: Counter = new Counter(100);
increment(c);
increment(c);
increment(c);
print(c.current());      // 103

// Constructor vacío.
class Empty {}
const e: Empty = new Empty();
print("ok");             // smoke: el constructor vacío no rompe nada
