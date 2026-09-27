// mut-none — demostrar mutIsSome con valor válido.
// (No hay literal null en el dialecto.)

class Empty {}
const e: Empty = new Empty();
const m: Mut<Empty> = mutFrom<Empty>(e);
print(mutIsSome(m) ? "some" : "none");
