// tcp-echo — Issue #14: servidor y cliente en el mismo proceso.
// El runtime `etsNetSyncEcho` levanta un server en background, hace listen en
// puerto 0 (kernel asigna), acepta una conexión, lee un mensaje, lo escribe
// de vuelta, cierra. El cliente se conecta y verifica. Puerto alto fijo
// (19100) para evitar conflictos entre tests.
let result: string = etsNetSyncEcho("127.0.0.1", 19100, "hello", 1024);
print(result);
