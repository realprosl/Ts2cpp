// benchmark_buffer_pool.cpp — micro-benchmark del BufferPool V26.
//
// Mide la diferencia entre:
//   - alloca fresh std::string(size, 'A') cada vez (V25 path).
//   - acquire/release del BufferPool (V26 path).
// Reporta speedup y memoria ahorrada.

#include <chrono>
#include <cstdio>
#include <string>

#include "ets_buffer_pool.hpp"

using Clock = std::chrono::steady_clock;

int main() {
    constexpr int N = 100000;
    constexpr std::size_t size = 4096;

    // V25: alloca fresh cada vez.
    auto t0 = Clock::now();
    long v25_sum = 0;
    for (int i = 0; i < N; ++i) {
        std::string buf(size, 'A');
        v25_sum += static_cast<long>(buf.capacity());
    }
    auto t1 = Clock::now();
    const auto v25_us = std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count();

    // V26: acquire/release del pool.
    auto t3 = Clock::now();
    long v26_sum = 0;
    for (int i = 0; i < N; ++i) {
        std::string buf = ets::BufferPool::instance().acquire(size);
        v26_sum += static_cast<long>(buf.capacity());
        ets::BufferPool::instance().release(std::move(buf));
    }
    auto t4 = Clock::now();
    const auto v26_us = std::chrono::duration_cast<std::chrono::microseconds>(t4 - t3).count();

    // Repetir pool para ver el cache hit.
    long v26_hot_sum = 0;
    auto t5 = Clock::now();
    for (int i = 0; i < N; ++i) {
        std::string buf = ets::BufferPool::instance().acquire(size);
        v26_hot_sum += static_cast<long>(buf.capacity());
        ets::BufferPool::instance().release(std::move(buf));
    }
    auto t6 = Clock::now();
    const auto v26_hot_us = std::chrono::duration_cast<std::chrono::microseconds>(t6 - t5).count();

    std::printf("N=%d iteraciones, size=%zu bytes\n", N, size);
    std::printf("V25 alloc fresh:  %ld us  (%.2f ns/op)\n", v25_us, v25_us * 1000.0 / N);
    std::printf("V26 pool:         %ld us  (%.2f ns/op)  -- primer pase (cold)\n", v26_us, v26_us * 1000.0 / N);
    std::printf("V26 pool:         %ld us  (%.2f ns/op)  -- segundo pase (hot)\n", v26_hot_us, v26_hot_us * 1000.0 / N);
    std::printf("Speedup cold vs V25: %.2fx\n", static_cast<double>(v25_us) / v26_us);
    std::printf("Speedup hot  vs V25: %.2fx\n", static_cast<double>(v25_us) / v26_hot_us);

    if (v25_sum != v26_sum || v26_sum != v26_hot_sum) {
        std::printf("ERROR: capacidad inconsistente\n");
        return 1;
    }
    std::printf("Capacidad consistente: %ld sum (matches)\n", v25_sum);
    return 0;
}