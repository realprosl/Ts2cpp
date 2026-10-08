// benchmark_accept4.cpp — micro-benchmark del V26 accept4 (Linux).
//
// Mide la diferencia entre accept() + fcntl(O_NONBLOCK) (2 syscalls)
// y accept4(fd, NULL, NULL, SOCK_NONBLOCK) (1 syscall). En sistemas
// sin accept4 (no Linux), el benchmark usa el fallback y mostrara
// "no accept4".

#include <chrono>
#include <cstdio>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

using Clock = std::chrono::steady_clock;

static int makeNonBlocking(int fd) {
    const int flags = ::fcntl(fd, F_GETFL, 0);
    return flags >= 0 && ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

int main() {
    // Crear un listener local para accept().
    const int server = ::socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0) { std::perror("socket"); return 1; }
    int reuse = 1;
    ::setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = 0;  // puerto cualquiera
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    ::bind(server, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    ::listen(server, 128);

    // Conectar al server desde el lado "cliente" -- pero sin enviar
    // datos, solo abrir el socket. El accept del server consumira esa
    // conexion.
    sockaddr_in saddr{};
    socklen_t slen = sizeof(saddr);
    ::getsockname(server, reinterpret_cast<sockaddr*>(&saddr), &slen);

    constexpr int N = 10000;

    // Cold start: medir accept() + fcntl (V25 path).
    auto t0 = Clock::now();
    int accepted_v25 = 0;
    for (int i = 0; i < N; ++i) {
        const int c = ::socket(AF_INET, SOCK_STREAM, 0);
        if (c < 0) continue;
        ::connect(c, reinterpret_cast<sockaddr*>(&saddr), sizeof(saddr));
        const int a = ::accept(server, nullptr, nullptr);
        if (a >= 0) {
            if (makeNonBlocking(a)) ++accepted_v25;
            ::close(a);
        }
        ::close(c);
    }
    auto t1 = Clock::now();
    const auto v25_us = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();

#ifdef SOCK_NONBLOCK
    // V26 path: socket + accept4 con SOCK_NONBLOCK.
    auto t2 = Clock::now();
    int accepted_v26 = 0;
    for (int i = 0; i < N; ++i) {
        const int c = ::socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
        if (c < 0) continue;
        ::connect(c, reinterpret_cast<sockaddr*>(&saddr), sizeof(saddr));
        const int a = ::accept4(server, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (a >= 0) { ++accepted_v26; ::close(a); }
        ::close(c);
    }
    auto t3 = Clock::now();
    const auto v26_us = std::chrono::duration_cast<std::chrono::microseconds>(t3 - t2).count();

    std::printf("N=%d accepts pares\n", N);
    std::printf("V25 accept+fcntl:  %ld us  (%.2f us/op)\n", v25_us, v25_us / static_cast<double>(N));
    std::printf("V26 accept4:       %ld us  (%.2f us/op)\n", v26_us, v26_us / static_cast<double>(N));
    std::printf("Speedup: %.2fx\n", static_cast<double>(v25_us) / v26_us);
    std::printf("V25 accepted: %d/%d, V26 accepted: %d/%d\n", accepted_v25, N, accepted_v26, N);
#else
    std::printf("N=%d accepts pares\n", N);
    std::printf("V25 accept+fcntl:  %ld us  (%.2f us/op)\n", v25_us, v25_us / static_cast<double>(N));
    std::printf("V26 accept4:       no SOCK_NONBLOCK en este sistema (fallback a V25)\n");
    std::printf("V25 accepted: %d/%d\n", accepted_v25, N);
#endif
    ::close(server);
    return 0;
}