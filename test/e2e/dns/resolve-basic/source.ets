// Test e2e: resolveDns (DNS async) sobre uv_getaddrinfo.
// Resuelve "127.0.0.1" (loopback, siempre funciona) y verifica
// que devuelve la IP correcta. Tambien prueba un host invalido
// (debe devolver string vacio).
//
// La coroutine se suspende en await, libuv resuelve el nombre,
// resume la coroutine, y el main async imprime el resultado.
async function main(): Promise<void> {
  let ip: string = await resolveDns("127.0.0.1");
  if (ip == "127.0.0.1") {
    print("ok:resolved-127.0.0.1");
  } else {
    print("fail:expected-127.0.0.1 got=" + ip);
  }
  let ip2: string = await resolveDns("localhost");
  if (ip2 == "127.0.0.1") {
    print("ok:resolved-localhost");
  } else {
    print("fail:localhost got=" + ip2);
  }
  let ip3: string = await resolveDns("this-host-does-not-exist-zzz.invalid");
  if (ip3 == "") {
    print("ok:invalid-host-empty");
  } else {
    print("fail:invalid got=" + ip3);
  }
}

main();
