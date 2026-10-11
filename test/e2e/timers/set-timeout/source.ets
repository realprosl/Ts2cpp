// Test e2e: setTimeout dispara el callback tras N ms.
// Compilacion:
//   g++ -std=c++20 -fno-exceptions -pthread -I/root/Ts2cpp \
//       source.cpp /root/Ts2cpp/build/runtime_ets_libuv.o \
//       /root/Ts2cpp/build/runtime_ets_net_libuv.o \
//       -lstdc++fs -luv -o source
// El programa imprime "scheduled" inmediatamente y "timer-fired"
// tras ~80ms, luego termina cuando el loop se queda sin handles.
let t: Timer = setTimeout((): void => {
  print("timer-fired");
}, 80);
print("scheduled");
