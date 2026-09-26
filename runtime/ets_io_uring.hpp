#pragma once

#include "runtime/ets_async.hpp"
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/io_uring.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#endif

namespace ets {

#if defined(__linux__) && defined(__NR_io_uring_setup) && defined(__NR_io_uring_enter)
namespace io_uring_detail {

class Ring {
public:
    Ring() {
        std::memset(&parameters_, 0, sizeof(parameters_));
        descriptor_ = static_cast<int>(::syscall(__NR_io_uring_setup, 16u, &parameters_));
        if (descriptor_ < 0) return;
        std::size_t sqSize = parameters_.sq_off.array + parameters_.sq_entries * sizeof(unsigned);
        std::size_t cqSize = parameters_.cq_off.cqes + parameters_.cq_entries * sizeof(io_uring_cqe);
        if (parameters_.features & IORING_FEAT_SINGLE_MMAP) sqSize = cqSize = std::max(sqSize, cqSize);
        sqSize_ = sqSize; cqSize_ = cqSize;
        sqRing_ = ::mmap(nullptr, sqSize, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, descriptor_, IORING_OFF_SQ_RING);
        cqRing_ = parameters_.features & IORING_FEAT_SINGLE_MMAP ? sqRing_ : ::mmap(nullptr, cqSize, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, descriptor_, IORING_OFF_CQ_RING);
        sqes_ = static_cast<io_uring_sqe*>(::mmap(nullptr, parameters_.sq_entries * sizeof(io_uring_sqe), PROT_READ | PROT_WRITE, MAP_SHARED | MAP_POPULATE, descriptor_, IORING_OFF_SQES));
        if (sqRing_ == MAP_FAILED || cqRing_ == MAP_FAILED || sqes_ == MAP_FAILED) { closeMappings(); return; }
        sqHead_ = pointer<unsigned>(sqRing_, parameters_.sq_off.head); sqTail_ = pointer<unsigned>(sqRing_, parameters_.sq_off.tail);
        sqMask_ = pointer<unsigned>(sqRing_, parameters_.sq_off.ring_mask); sqArray_ = pointer<unsigned>(sqRing_, parameters_.sq_off.array);
        cqHead_ = pointer<unsigned>(cqRing_, parameters_.cq_off.head); cqTail_ = pointer<unsigned>(cqRing_, parameters_.cq_off.tail);
        cqMask_ = pointer<unsigned>(cqRing_, parameters_.cq_off.ring_mask); cqes_ = pointer<io_uring_cqe>(cqRing_, parameters_.cq_off.cqes);
        valid_ = true;
    }
    Ring(const Ring&) = delete;
    Ring& operator=(const Ring&) = delete;
    ~Ring() { closeMappings(); }
    bool valid() const noexcept { return valid_; }
    int execute(unsigned char opcode, int file, void* buffer, unsigned size, std::uint64_t offset) noexcept {
        if (!valid_) return -ENOSYS;
        const unsigned tail = __atomic_load_n(sqTail_, __ATOMIC_RELAXED);
        const unsigned index = tail & *sqMask_;
        io_uring_sqe& request = sqes_[index];
        std::memset(&request, 0, sizeof(request));
        request.opcode = opcode; request.fd = file; request.off = offset;
        request.addr = reinterpret_cast<std::uint64_t>(buffer); request.len = size;
        sqArray_[index] = index;
        __atomic_store_n(sqTail_, tail + 1, __ATOMIC_RELEASE);
        if (::syscall(__NR_io_uring_enter, descriptor_, 1u, 1u, IORING_ENTER_GETEVENTS, nullptr, 0u) < 0) return -errno;
        const unsigned head = __atomic_load_n(cqHead_, __ATOMIC_ACQUIRE);
        if (head == __atomic_load_n(cqTail_, __ATOMIC_ACQUIRE)) return -EIO;
        const int result = cqes_[head & *cqMask_].res;
        __atomic_store_n(cqHead_, head + 1, __ATOMIC_RELEASE);
        return result;
    }
private:
    template <typename T> static T* pointer(void* base, unsigned offset) { return reinterpret_cast<T*>(static_cast<char*>(base) + offset); }
    void closeMappings() noexcept {
        if (sqes_ && sqes_ != MAP_FAILED) ::munmap(sqes_, parameters_.sq_entries * sizeof(io_uring_sqe));
        if (sqRing_ && sqRing_ != MAP_FAILED) ::munmap(sqRing_, sqSize_);
        if (!(parameters_.features & IORING_FEAT_SINGLE_MMAP) && cqRing_ && cqRing_ != MAP_FAILED) ::munmap(cqRing_, cqSize_);
        if (descriptor_ >= 0) ::close(descriptor_);
        descriptor_ = -1; sqRing_ = cqRing_ = nullptr; sqes_ = nullptr; valid_ = false;
    }
    io_uring_params parameters_{};
    int descriptor_ = -1; bool valid_ = false;
    void* sqRing_ = nullptr; void* cqRing_ = nullptr; io_uring_sqe* sqes_ = nullptr;
    unsigned *sqHead_ = nullptr, *sqTail_ = nullptr, *sqMask_ = nullptr, *sqArray_ = nullptr;
    unsigned *cqHead_ = nullptr, *cqTail_ = nullptr, *cqMask_ = nullptr; io_uring_cqe* cqes_ = nullptr;
    std::size_t sqSize_ = 0, cqSize_ = 0;
};

inline thread_local Ring ring;

inline Result<std::string> read(const std::string& path) {
    const int descriptor = ::open(path.c_str(), O_RDONLY);
    if (descriptor < 0) return err<std::string>("No se puede leer: " + path + ": " + std::strerror(errno));
    struct stat metadata {};
    if (::fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode)) { ::close(descriptor); return err<std::string>("io_uring requiere un archivo regular: " + path); }
    std::string contents(static_cast<std::size_t>(metadata.st_size), '\0');
    std::size_t offset = 0;
    while (offset < contents.size()) {
        const unsigned chunk = static_cast<unsigned>(std::min<std::size_t>(contents.size() - offset, std::numeric_limits<unsigned>::max()));
        const int received = ring.execute(IORING_OP_READ, descriptor, contents.data() + offset, chunk, offset);
        if (received < 0) { ::close(descriptor); return err<std::string>("Error io_uring leyendo: " + path + ": " + std::strerror(-received)); }
        if (received == 0) { contents.resize(offset); break; }
        offset += static_cast<std::size_t>(received);
    }
    ::close(descriptor);
    return ok(std::move(contents));
}

inline Result<bool> write(const std::string& path, const std::string& contents, bool append) {
    const int descriptor = ::open(path.c_str(), O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC), 0666);
    if (descriptor < 0) return err<bool>("No se puede escribir: " + path + ": " + std::strerror(errno));
    std::size_t offset = 0;
    while (offset < contents.size()) {
        const unsigned chunk = static_cast<unsigned>(std::min<std::size_t>(contents.size() - offset, std::numeric_limits<unsigned>::max()));
        const std::uint64_t fileOffset = append ? std::numeric_limits<std::uint64_t>::max() : offset;
        const int written = ring.execute(IORING_OP_WRITE, descriptor, const_cast<char*>(contents.data() + offset), chunk, fileOffset);
        if (written <= 0) { const int code = written < 0 ? -written : EIO; ::close(descriptor); return err<bool>("Error io_uring escribiendo: " + path + ": " + std::strerror(code)); }
        offset += static_cast<std::size_t>(written);
    }
    ::close(descriptor);
    return ok(true);
}

} // namespace io_uring_detail

inline bool ioUringAvailable() noexcept { return io_uring_detail::ring.valid(); }
#else
inline bool ioUringAvailable() noexcept { return false; }
#endif

} // namespace ets
