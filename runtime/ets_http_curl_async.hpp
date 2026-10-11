// runtime/ets_http_curl_async.hpp — Cliente HTTP async con corutinas.
//
// V30.3: Sustituye a httpClientGet/httpClientPost sincronos cuando se
// usan con `await`. La implementacion usa runBlocking (que internamente
// usa BlockingAwaiter de runtime/ets_async.hpp) que envuelve
// curl_easy_perform en un worker thread del blockingExecutor. La
// corutina se suspende, el worker hace el HTTP request bloqueante, y
// cuando termina hace `loop->post(handle)` para reanudar la corutina
// en el event loop.
//
// API del dialecto (mismo nombre que la version sincrona):
//
//   let r: Promise<Result<HttpClientResponse,string>> = http.get(url)
//   let r: Promise<Result<HttpClientResponse,string>> = http.post(url, body, contentType?)
//
// El codegen traduce a `::ets::httpClientGetAsync(url)` que retorna
// `ets::Task<ets::Result<HttpClientResponse>>`. El `co_await` del
// dialecto suspende la corutina y la reanuda cuando el worker termina.
//
// Limitaciones:
//   - curl_easy_perform es BLOQUEANTE. El worker thread es del
//     blockingExecutor, asi que no bloquea el event loop del main.
//   - HTTPS, redirects, decompression: igual que la version sincrona.
//   - Si se cancela la corutina, curl_easy_perform sigue hasta terminar
//     (no hay interrupcion de libcurl todavia).
//
// Compilacion:
//   g++ -std=c++20 -I. programa.cpp -lcurl -o programa

#pragma once

#include "ets_http_curl_client.hpp"  // HttpClientResponse, Result, httpClientGet, httpClientPost
#include "ets_async.hpp"               // Task, runBlocking, defaultEventLoop

#include <string>
#include <utility>

namespace ets {

// ----------------------------------------------------------------------------
// httpClientGetAsync(url) -> Task<Result<HttpClientResponse>>.
// ----------------------------------------------------------------------------
inline Task<Result<HttpClientResponse>> httpClientGetAsync(std::string url) {
    co_return co_await runBlocking([url = std::move(url)]() -> Result<HttpClientResponse> {
        return httpClientGet(url);
    });
}

// ----------------------------------------------------------------------------
// httpClientPostAsync(url, body, contentType) -> Task<Result<HttpClientResponse>>.
// ----------------------------------------------------------------------------
inline Task<Result<HttpClientResponse>> httpClientPostAsync(
    std::string url, std::string body, std::string contentType) {
    co_return co_await runBlocking(
        [url = std::move(url), body = std::move(body), contentType = std::move(contentType)]() -> Result<HttpClientResponse> {
            return httpClientPost(url, body, contentType);
        });
}

}  // namespace ets
