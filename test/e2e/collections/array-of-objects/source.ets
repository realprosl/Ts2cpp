// array-of-objects — array de objetos con varios campos.
//
// El dialecto no soporta tipos inline `Array<{ ... }>` en el lenguaje
// fuente; hay que declarar el tipo del objeto como `class` (o interface)
// y luego vectorizarlo. Aquí iteramos sumando edades y concatenando
// nombres para validar acceso a múltiples campos por elemento.

class Person {
  name: string;
  age: number;
}

let p1: Person = new Person("Ana", 30);
let p2: Person = new Person("Luis", 25);
let p3: Person = new Person("Mia", 40);
let people: Person[] = [p1, p2, p3];

let totalAge: number = 0;
let names: string = "";
for (const p of people) {
  totalAge = totalAge + p.age;
  names = names + p.name + " ";
}

print(numberToString(totalAge));
print(names);
print(numberToString(length(people)));
