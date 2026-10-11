// interface-basic: smoke test del parser de interfaces.
// V30.5.3 fix: el parser de interfaces no llamaba a skipNewlines()
// en el bucle de métodos, lo que causaba que el primer método
// después del `{` no se parseara (el primer token era `newline`).
// Antes del fix, este programa daba error "Se esperaba el nombre
// del método" en la línea 3 columna 7.
//
// Smoke test: declaramos una interface y referenciamos sus metodos
// en una clase que se compila. El codegen emite la interface como
// struct C++ con los miembros declarados; verificamos que la
// salida compile sin errores de parser.

interface Counter {
  increment(): number;
  reset(): number;
}

class CounterImpl {
  count: number;
  constructor() { this.count = 0; }
  increment(): number { this.count = this.count + 1; return this.count; }
  reset(): number { this.count = 0; return this.count; }
}

let c: CounterImpl = new CounterImpl();
print(numberToString(c.increment()));
print(numberToString(c.increment()));
print(numberToString(c.reset()));
print(numberToString(c.increment()));
