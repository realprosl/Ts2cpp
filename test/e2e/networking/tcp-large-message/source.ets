// tcp-large-message — envía 64KB a través de TCP y verifica recepción.
// Usa el helper de alto nivel `etsNetSyncLarge` que envía/recibe grandes bloques.
let response: string = etsNetSyncLarge("127.0.0.1", 19101, 65536);
print("size=" + numberToString(length(response)));
