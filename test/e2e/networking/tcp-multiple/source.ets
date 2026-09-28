// tcp-multiple — tres llamadas consecutivas al helper, cada una en su puerto.
let r1: string = etsNetSyncEcho("127.0.0.1", 19102, "one", 1024);
let r2: string = etsNetSyncEcho("127.0.0.1", 19103, "two", 1024);
let r3: string = etsNetSyncEcho("127.0.0.1", 19104, "three", 1024);
print(r1);
print(r2);
print(r3);
