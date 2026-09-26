// Demo del API estilo Node expuesta como built-in `fs` en Estatic.
// (Sin `async function main` porque el `int main` de C++ no puede ser corutina;
//  el codegen traduce `await` a top-level a `ets::syncWait`.)

// --- Sync ---------------------------------------------------------------
if (fs.existsSync("/tmp/fs-demo.txt")) {
  const removed: Result<boolean> = fs.unlinkSync("/tmp/fs-demo.txt");
  if (removed.isOk() == false) { console.error("unlink previo falló:", removed.error()); }
}
const written: Result<boolean> = fs.writeFileSync("/tmp/fs-demo.txt", "hola fs\n");
if (written.isOk() == false) { console.error("write falló:", written.error()); }
console.log("escrito OK");

const contents: Result<string> = fs.readFileSync("/tmp/fs-demo.txt");
if (contents.isOk() == false) { console.error("read falló:", contents.error()); }
console.log("leído sync:", contents.value());

// --- Async --------------------------------------------------------------
const asyncRead: Promise<Result<string>> = fs.readFile("/tmp/fs-demo.txt");
const asyncResult: Result<string> = await asyncRead;
if (asyncResult.isOk() == false) { console.error("async read falló:", asyncResult.error()); }
console.log("leído async:", asyncResult.value());

const removed: Result<boolean> = fs.unlinkSync("/tmp/fs-demo.txt");
if (removed.isOk() == false) { console.error("unlink falló:", removed.error()); }
console.log("borrado OK");
