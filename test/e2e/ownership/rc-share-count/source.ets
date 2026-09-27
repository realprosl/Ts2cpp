// rc-share-count — rcShare, copiar Rc, rcStrongCount incrementa.

class Data { value: number; constructor(v: number) { this.value = v; } }

const a: Rc<Data> = rcShare<Data>(new Data(7));
const b: Rc<Data> = a;
const c: Rc<Data> = a;

print(numberToString(rcStrongCount(a)));
print(numberToString(rcStrongCount(b)));
print(numberToString(rcStrongCount(c)));
