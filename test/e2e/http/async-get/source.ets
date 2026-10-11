// Test e2e: V30.3 cliente HTTP async con await + corutinas.
//
// Verifica que el codegen emite `co_await ::ets::httpClientGetAsync(url)`
// cuando se usa `await http.get(url)`, que el include de
// `runtime/ets_http_curl_async.hpp` se arrastra correctamente, y que
// el binario compila con -lcurl -luv.
//
// El roundtrip end-to-end con un server local se valida con
// .scratch/test_http_async_get.ets (manual) y con
// runtime/libuv/tests/test_http_async_get.cpp (test runtime C++).
//
// Antes (V28-V30.2): http.get(url) -> Result<HttpClientResponse, string>
//                    (sincrono, bloqueante)
// Ahora (V30.3):    http.get(url) -> Promise<Result<HttpClientResponse, string>>
//                    (async, via co_await + worker thread)
//
// El await se hace contra 127.0.0.1:1 (puerto reservado sin servicio),
// asi curl_easy_perform falla rapido con "connection refused" (~ms).
// Eso valida que el await completa (no se cuelga) y que el main async
// termina limpiamente. El print al final demuestra que el codepath
// completo (codegen + compilar + ejecutar + syncWait + BlockingAwaiter
// + worker thread + post back al loop) funciona.
async function main(): Promise<void> {
  let r: Result<HttpClientResponse, string> = await http.get("http://127.0.0.1:1/never");
  print("compiled-with-http-async-await");
}
main();
