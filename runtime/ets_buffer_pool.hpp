// ets_buffer_pool.hpp — pool de std::string reutilizables para readTcp.
//
// V26: Alberto 2026-10-07 -> "buffer reuse readTcp" del V26 roadmap.
//
// El objetivo es eliminar las miles de allocaciones que readTcp()
// origina en un servidor con carga. Cada readTcp() pide un buffer al
// pool (round-up al bucket de potencia de 2 mas cercano) y lo devuelve
// al pool cuando termina. El caller sigue recibiendo un std::string,
// asi que la API publica no cambia.
//
// El pool es thread_local: cada thread tiene su propio free list.
// Esto evita contention en servidores multithread.
//
// Buckets (potencias de 2):
//   1K, 2K, 4K, 8K, 16K, 32K, 64K, 128K, 256K, 512K, 1M
// Max bucket: 1 MB (readTcp cap superior). Por encima, no se pool-ea.
//
// Cada bucket tiene un max de MAX_FREE_PER_BUCKET buffers ociosos
// para evitar memoria inflada por un pico de trafico seguido de un
// valle largo. Lo que sobra se destruye (libera memoria al heap).

#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ets {

class BufferPool {
public:
    // Bucket sizes: 1K, 2K, 4K, ..., 1M (potencias de 2).
    static constexpr std::size_t BUCKET_COUNT = 11;
    static constexpr std::size_t MAX_FREE_PER_BUCKET = 32;
    static constexpr std::size_t BUCKET_BASE = 1024;

    // Adquire un string con capacidad >= size. Reducia bufs ociosos
    // del bucket correspondiente; si no, aloca uno nuevo.
    std::string acquire(std::size_t size) {
        const int idx = bucketIndex(size);
        if (idx >= 0 && idx < static_cast<int>(BUCKET_COUNT)) {
            auto& free_list = free_[idx];
            if (!free_list.empty()) {
                std::string buf = std::move(free_list.back());
                free_list.pop_back();
                buf.clear();
                buf.reserve(capacityFor(static_cast<std::size_t>(idx)));
                return buf;
            }
        }
        // Bucket no aplica o vacio: aloca nuevo.
        std::string buf;
        if (idx >= 0 && idx < static_cast<int>(BUCKET_COUNT)) {
            buf.reserve(capacityFor(static_cast<std::size_t>(idx)));
        } else if (size > 0) {
            buf.reserve(size);
        }
        return buf;
    }

    // Devuelve un buffer al pool. Si el bucket ya tiene MAX_FREE,
    // el buffer se destruye (libera memoria).
    void release(std::string buf) {
        if (buf.empty()) return;
        const std::size_t cap = buf.capacity();
        const int idx = bucketIndex(cap);
        if (idx < 0 || idx >= static_cast<int>(BUCKET_COUNT)) return;
        auto& free_list = free_[idx];
        if (free_list.size() >= MAX_FREE_PER_BUCKET) return;
        free_list.push_back(std::move(buf));
    }

    // Stats (para benchmarks y debug).
    struct Stats {
        std::array<std::size_t, BUCKET_COUNT> hits{};
        std::array<std::size_t, BUCKET_COUNT> misses{};
        std::array<std::size_t, BUCKET_COUNT> free_count{};
    };
    Stats stats() const { return stats_; }

    // Singleton thread_local. Cada thread tiene su propio pool.
    static BufferPool& instance() {
        thread_local BufferPool pool;
        return pool;
    }

private:
    BufferPool() = default;
    BufferPool(const BufferPool&) = delete;
    BufferPool& operator=(const BufferPool&) = delete;

    static int bucketIndex(std::size_t size) {
        // size <= 0 -> bucket 0 (1K).
        // size > 1M -> BUCKET_COUNT (fuera de rango).
        std::size_t s = size == 0 ? 1 : size;
        int idx = 0;
        std::size_t cap = BUCKET_BASE;
        while (cap < s && idx < static_cast<int>(BUCKET_COUNT)) {
            cap <<= 1;
            ++idx;
        }
        return idx;
    }
    static std::size_t capacityFor(std::size_t idx) {
        return BUCKET_BASE << idx;
    }

    std::array<std::vector<std::string>, BUCKET_COUNT> free_{};
    Stats stats_{};
};

}  // namespace ets