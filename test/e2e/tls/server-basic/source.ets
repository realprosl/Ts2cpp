// Test e2e: V30.5 TLS server con createTlsServer (smoke test).
//
// NOTA: el dialecto .ets todavía no expone una forma idiomática
// de extraer el valor de un `Result<T>` sin `match` (`.value`
// no se permite porque Result es una tagged union). Como
// createTlsServer retorna `Result<TlsContext>`, este test no
// puede continuar al accept. Se queda como smoke test: valida
// que el codegen emite `::ets::createTlsServer(...)` y que el
// include de `runtime/ets_tls.hpp` se arrastra, y que el binario
// compila con -lssl -lcrypto -luv.
//
// El roundtrip end-to-end (handshake + readTls + writeTls +
// closeTls) se valida con:
//   - runtime/libuv/tests/test_tls_handshake.cpp (cliente
//     openssl externo, valida handshake + acceptTls + writeTls
//     + closeTls).
//
// Cuando el dialecto madure el manejo de Result<> (match con
// tipos generics o .value/.error en Result<>) este test se
// extendera a acceptTls/readTls/writeTls.

let ctx = createTlsServer(
    "runtime/libuv/tests/tls/cert.pem",
    "runtime/libuv/tests/tls/key.pem"
)
print("tls-codegen-ok")
