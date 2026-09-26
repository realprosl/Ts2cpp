#pragma once

#include "runtime/ets_net.hpp"
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <memory>
#include <string>

namespace ets {

inline std::string tlsError(const std::string& operation) {
    const unsigned long code = ::ERR_get_error();
    if (code == 0) return operation;
    char buffer[256];
    ::ERR_error_string_n(code, buffer, sizeof(buffer));
    return operation + ": " + buffer;
}

struct TlsContextState {
    explicit TlsContextState(SSL_CTX* value) : context(value) {}
    ~TlsContextState() { if (context) ::SSL_CTX_free(context); }
    SSL_CTX* context = nullptr;
};

class TlsContext {
public:
    TlsContext() = default;
    explicit TlsContext(SSL_CTX* context) : state_(std::make_shared<TlsContextState>(context)) {}
    bool valid() const noexcept { return state_ && state_->context; }
    SSL_CTX* native() const noexcept { return valid() ? state_->context : nullptr; }
private:
    std::shared_ptr<TlsContextState> state_;
};

struct TlsConnectionState {
    TlsConnectionState(SSL* value, TcpConnection socket) : ssl(value), connection(std::move(socket)) {}
    ~TlsConnectionState() { if (ssl) ::SSL_free(ssl); }
    SSL* ssl = nullptr;
    TcpConnection connection;
};

class TlsConnection {
public:
    TlsConnection() = default;
    TlsConnection(SSL* ssl, TcpConnection connection) : state_(std::make_shared<TlsConnectionState>(ssl, std::move(connection))) {}
    bool valid() const noexcept { return state_ && state_->ssl && state_->connection.valid(); }
    SSL* native() const noexcept { return valid() ? state_->ssl : nullptr; }
    int fd() const noexcept { return valid() ? state_->connection.fd() : -1; }
    void close() const noexcept {
        if (!valid()) return;
        ::SSL_shutdown(state_->ssl);
        state_->connection.close();
    }
private:
    std::shared_ptr<TlsConnectionState> state_;
};

inline Result<TlsContext> createTlsServer(const std::string& certificatePath, const std::string& privateKeyPath) {
    ::OPENSSL_init_ssl(0, nullptr);
    SSL_CTX* context = ::SSL_CTX_new(::TLS_server_method());
    if (!context) return Result<TlsContext>::failure(tlsError("No se puede crear el contexto TLS"));
    ::SSL_CTX_set_min_proto_version(context, TLS1_2_VERSION);
    if (::SSL_CTX_use_certificate_chain_file(context, certificatePath.c_str()) != 1) {
        const auto error = tlsError("No se puede cargar el certificado TLS"); ::SSL_CTX_free(context); return Result<TlsContext>::failure(error);
    }
    if (::SSL_CTX_use_PrivateKey_file(context, privateKeyPath.c_str(), SSL_FILETYPE_PEM) != 1 || ::SSL_CTX_check_private_key(context) != 1) {
        const auto error = tlsError("No se puede cargar la clave privada TLS"); ::SSL_CTX_free(context); return Result<TlsContext>::failure(error);
    }
    return Result<TlsContext>::success(TlsContext{context});
}

inline Task<Result<TlsConnection>> acceptTls(TcpListener listener, TlsContext context, double timeoutMilliseconds, CancellationToken token) {
    const auto accepted = co_await acceptTcpUntil(listener, timeoutMilliseconds, token);
    if (!accepted.isOk()) co_return Result<TlsConnection>::failure(accepted.error());
    TcpConnection connection = accepted.value();
    SSL* ssl = ::SSL_new(context.native());
    if (!ssl) co_return Result<TlsConnection>::failure(tlsError("No se puede crear la sesión TLS"));
    ::SSL_set_fd(ssl, connection.fd());
    ::SSL_set_accept_state(ssl);
    const auto deadline = networkDeadline(timeoutMilliseconds);
    for (;;) {
        const int status = ::SSL_accept(ssl);
        if (status == 1) co_return Result<TlsConnection>::success(TlsConnection{ssl, std::move(connection)});
        const int error = ::SSL_get_error(ssl, status);
        if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) {
            const auto message = tlsError("Handshake TLS fallido"); ::SSL_free(ssl); co_return Result<TlsConnection>::failure(message);
        }
        const short events = error == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT;
        const auto waited = co_await CancellableFdAwaiter{connection.fd(), events, deadline, token};
        if (waited != WaitResult::ready) {
            const auto message = waitError(waited, "Handshake TLS"); ::SSL_free(ssl); co_return Result<TlsConnection>::failure(message);
        }
    }
}

inline Task<Result<std::string>> readTls(TlsConnection connection, double requestedBytes, double timeoutMilliseconds, CancellationToken token) {
    if (!connection.valid()) co_return Result<std::string>::failure("Conexión TLS cerrada");
    std::size_t size = requestedBytes <= 0 ? 1 : static_cast<std::size_t>(requestedBytes);
    if (size > 1024 * 1024) size = 1024 * 1024;
    std::string buffer(size, '\0');
    const auto deadline = networkDeadline(timeoutMilliseconds);
    for (;;) {
        const int received = ::SSL_read(connection.native(), buffer.data(), static_cast<int>(buffer.size()));
        if (received > 0) { buffer.resize(static_cast<std::size_t>(received)); co_return Result<std::string>::success(std::move(buffer)); }
        const int error = ::SSL_get_error(connection.native(), received);
        if (error == SSL_ERROR_ZERO_RETURN) { buffer.clear(); co_return Result<std::string>::success(std::move(buffer)); }
        if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) co_return Result<std::string>::failure(tlsError("Lectura TLS fallida"));
        const short events = static_cast<short>(error == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT);
        const auto waited = co_await CancellableFdAwaiter{connection.fd(), events, deadline, token};
        if (waited != WaitResult::ready) co_return Result<std::string>::failure(waitError(waited, "Lectura TLS"));
    }
}

inline Task<Result<double>> writeTls(TlsConnection connection, std::string data, double timeoutMilliseconds, CancellationToken token) {
    if (!connection.valid()) co_return Result<double>::failure("Conexión TLS cerrada");
    std::size_t offset = 0;
    const auto deadline = networkDeadline(timeoutMilliseconds);
    while (offset < data.size()) {
        const int written = ::SSL_write(connection.native(), data.data() + offset, static_cast<int>(data.size() - offset));
        if (written > 0) { offset += static_cast<std::size_t>(written); continue; }
        const int error = ::SSL_get_error(connection.native(), written);
        if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) co_return Result<double>::failure(tlsError("Escritura TLS fallida"));
        const short events = static_cast<short>(error == SSL_ERROR_WANT_READ ? POLLIN : POLLOUT);
        const auto waited = co_await CancellableFdAwaiter{connection.fd(), events, deadline, token};
        if (waited != WaitResult::ready) co_return Result<double>::failure(waitError(waited, "Escritura TLS"));
    }
    co_return Result<double>::success(static_cast<double>(offset));
}

inline void closeTls(const TlsConnection& connection) noexcept { connection.close(); }

} // namespace ets

using ets::acceptTls;
using ets::closeTls;
using ets::createTlsServer;
using ets::readTls;
using ets::writeTls;
