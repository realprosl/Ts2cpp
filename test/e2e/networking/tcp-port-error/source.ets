// tcp-port-error — abrir dos listeners en el mismo puerto.
// El segundo debe fallar porque el puerto ya está en uso.
let fd1: number = tcpListen("127.0.0.1", 19110);
let fd2: number = tcpListen("127.0.0.1", 19110);
if (fd1 >= 0 && fd2 < 0) {
  print("error:port-in-use");
} else {
  print("ok:port-not-in-use");
}
tcpClose(fd1);
