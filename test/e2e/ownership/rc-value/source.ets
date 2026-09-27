// rc-value — rcValue lee el valor compartido.

class Name { name: string; constructor(n: string) { this.name = n; } }

const shared: Rc<Name> = rcShare<Name>(new Name("alpha"));
const copy: Rc<Name> = shared;
print(rcValue(copy).name);
print(rcValue(shared).name);
