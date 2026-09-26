// Demo de Map<K, V> y Set<T>: ejercita la API estilo JavaScript sobre los
// wrappers `ets::Map` y `ets::Set` (basados en std::unordered_map/unordered_set).

function demo(): void {
  let scores: Map<string, number> = new Map<string, number>();
  scores.set("alice", 10);
  scores.set("bob", 20);
  scores.set("carol", 30);
  console.log("tamaño:" + numberToString(scores.size()));
  let bobTxt: string = "no";
  if (scores.has("bob")) { bobTxt = "sí"; }
  console.log("tiene bob:" + bobTxt);
  let delTxt: string = "no";
  if (scores.delete("carol")) { delTxt = "sí"; }
  console.log("borrar carol:" + delTxt);
  console.log("tras borrar:" + numberToString(scores.size()));

  // forEach itera como (value, key). Aquí solo contamos para verificar que
  // se invoca el callback por cada entrada restante.
  let pairsCount: number = 0;
  scores.forEach((value: number, key: string) => {
    pairsCount = pairsCount + 1;
  });
  console.log("pares contados:" + numberToString(pairsCount));

  let seen: Set<string> = new Set<string>();
  seen.add("rojo");
  seen.add("verde");
  seen.add("rojo");
  console.log("set size:" + numberToString(seen.size()));
  let verdeTxt: string = "no";
  if (seen.has("verde")) { verdeTxt = "sí"; }
  console.log("set tiene verde:" + verdeTxt);
  seen.delete("rojo");
  console.log("set tras delete:" + numberToString(seen.size()));

  // Set.forEach itera como (value). Mismo patrón: contar invocaciones.
  let tagsCount: number = 0;
  seen.forEach((value: string) => {
    tagsCount = tagsCount + 1;
  });
  console.log("set forEach total:" + numberToString(tagsCount));

  scores.clear();
  seen.clear();
  console.log("vacío map:" + numberToString(scores.size()));
  console.log("vacío set:" + numberToString(seen.size()));
}

demo();
