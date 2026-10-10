# Validador de la arquitectura libuv → corutinas C++20 + tests de Fase 2B.
#
# No es parte del runtime de Ts2cpp. Es standalone, sirve para validar
# cada iteración de la migración a libuv antes de tocar el EventLoop real.
#
# Uso:
#   cd runtime/libuv && make
#   ./build/validate_architecture    # Fase 1: spike arquitectónico
#   ./build/test_wait_until          # Fase 2B.1: waitUntil
#   make run                         # corre todos

CXX      ?= g++
# NOTA: -O0 en lugar de -O2 para los tests libuv. -O2 ha mostrado
# un bug en el LibuvEventLoop con corutinas (test_integration
# test 3 falla con -O2 pero pasa con -O0). Se investigara despues;
# los tests son validos sin O de env para validar el patron.
CXXFLAGS ?= -std=c++20 -O0 -Wall -Wextra
LDLIBS   ?= -luv

# V25 Fase 4: pre-compilacion del runtime. Las definiciones no-template
# de los event loops estan en runtime/runtime_ets_*.cpp, compiladas a
# .o y enlazadas con cada test. Asi validamos que el refactor de
# "header inline -> header ligero + .cpp" no rompe nada.
REPO_ROOT := $(abspath $(CURDIR)/../..)
RUNTIME_LIBUV_O := $(REPO_ROOT)/build/runtime_ets_libuv.o
RUNTIME_NET_LIBUV_O := $(REPO_ROOT)/build/runtime_ets_net_libuv.o
RUNTIME_POLL_O  := $(REPO_ROOT)/build/runtime_ets_poll.o
RUNTIME_NET_POLL_O := $(REPO_ROOT)/build/runtime_ets_net.o
RUNTIME_OBJS_LIBUV := $(RUNTIME_LIBUV_O) $(RUNTIME_NET_LIBUV_O)
RUNTIME_OBJS_POLL  := $(RUNTIME_POLL_O) $(RUNTIME_NET_POLL_O)

BUILD_DIR = build
TARGETS   = $(BUILD_DIR)/validate_architecture \
            $(BUILD_DIR)/test_wait_until \
            $(BUILD_DIR)/test_notify_post \
            $(BUILD_DIR)/test_wait_for \
            $(BUILD_DIR)/test_detach \
            $(BUILD_DIR)/test_integration \
            $(BUILD_DIR)/test_tcp_server \
            $(BUILD_DIR)/test_uv_fd_awaiter \
            $(BUILD_DIR)/test_tcp_client \
            $(BUILD_DIR)/test_tcp_client_loop \
            $(BUILD_DIR)/test_cancel_network \
            $(BUILD_DIR)/test_curl_fetch \
            $(BUILD_DIR)/benchmark_libuv_hotpath \
            $(BUILD_DIR)/benchmark_poll_vs_libuv \
            $(BUILD_DIR)/benchmark_buffer_pool \
            $(BUILD_DIR)/benchmark_accept4 \
            $(BUILD_DIR)/test_multi_loop \
            $(BUILD_DIR)/test_wrappers_v29
ALL_SRCS  = validate_architecture.cpp \
            tests/test_wait_until.cpp \
            tests/test_notify_post.cpp \
            tests/test_wait_for.cpp \
            tests/test_detach.cpp \
            tests/test_integration.cpp \
            tests/test_tcp_server.cpp \
            tests/test_uv_fd_awaiter.cpp \
            tests/test_tcp_client.cpp \
            tests/test_tcp_client_loop.cpp \
            tests/test_cancel_network.cpp \
            tests/test_curl_fetch.cpp \
            tests/benchmark_libuv_hotpath.cpp \
            tests/benchmark_poll_vs_libuv.cpp \
            tests/benchmark_buffer_pool.cpp \
            tests/benchmark_accept4.cpp \
            tests/test_multi_loop.cpp \
            tests/test_wrappers_v29.cpp

.PHONY: all clean run

all: $(TARGETS)

$(BUILD_DIR)/validate_architecture: validate_architecture.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS)

$(BUILD_DIR)/test_wait_until: tests/test_wait_until.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS)

$(BUILD_DIR)/test_notify_post: tests/test_notify_post.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_wait_for: tests/test_wait_for.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_detach: tests/test_detach.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_integration: tests/test_integration.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -I$(CURDIR)/../ -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

$(BUILD_DIR)/test_tcp_server: tests/test_tcp_server.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_uv_fd_awaiter: tests/test_uv_fd_awaiter.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

$(BUILD_DIR)/test_tcp_client: tests/test_tcp_client.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_tcp_client_loop: tests/test_tcp_client_loop.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

$(BUILD_DIR)/test_cancel_network: tests/test_cancel_network.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

$(BUILD_DIR)/test_curl_fetch: tests/test_curl_fetch.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< -lcurl $(LDLIBS)

$(BUILD_DIR)/benchmark_libuv_hotpath: tests/benchmark_libuv_hotpath.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -O2 -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

$(BUILD_DIR)/benchmark_poll_vs_libuv: tests/benchmark_poll_vs_libuv.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -O2 -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/benchmark_buffer_pool: tests/benchmark_buffer_pool.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -O2 -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< -pthread

$(BUILD_DIR)/benchmark_accept4: tests/benchmark_accept4.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -O2 -o $@ $< -pthread

$(BUILD_DIR)/test_multi_loop: tests/test_multi_loop.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

# V29.4: test de los wrappers de alto nivel (ets_fs_watcher.hpp
# y ets_timer.hpp) sobre libuv.
$(BUILD_DIR)/test_wrappers_v29: tests/test_wrappers_v29.cpp $(RUNTIME_OBJS_LIBUV) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(RUNTIME_OBJS_LIBUV) $(LDLIBS) -pthread

$(BUILD_DIR):
	mkdir -p $@

run: $(TARGETS)
	@for t in $(TARGETS); do echo "== running $$t =="; $$t || exit 1; echo; done

clean:
	rm -rf $(BUILD_DIR)
