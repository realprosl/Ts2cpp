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
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra
LDLIBS   ?= -luv

BUILD_DIR = build
TARGETS   = $(BUILD_DIR)/validate_architecture \
            $(BUILD_DIR)/test_wait_until \
            $(BUILD_DIR)/test_notify_post \
            $(BUILD_DIR)/test_wait_for \
            $(BUILD_DIR)/test_detach \
            $(BUILD_DIR)/test_integration \
            $(BUILD_DIR)/test_tcp_server \
            $(BUILD_DIR)/test_uv_fd_awaiter \
            $(BUILD_DIR)/test_tcp_client
ALL_SRCS  = validate_architecture.cpp \
            tests/test_wait_until.cpp \
            tests/test_notify_post.cpp \
            tests/test_wait_for.cpp \
            tests/test_detach.cpp \
            tests/test_integration.cpp \
            tests/test_tcp_server.cpp \
            tests/test_uv_fd_awaiter.cpp \
            tests/test_tcp_client.cpp

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

$(BUILD_DIR)/test_integration: tests/test_integration.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -DETS_EVENT_BACKEND_LIBUV -I$(CURDIR)/../ -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_tcp_server: tests/test_tcp_server.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_uv_fd_awaiter: tests/test_uv_fd_awaiter.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -DETS_EVENT_BACKEND_LIBUV -I$(CURDIR)/../ -I$(CURDIR)/../.. -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR)/test_tcp_client: tests/test_tcp_client.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS) -pthread

$(BUILD_DIR):
	mkdir -p $@

run: $(TARGETS)
	@for t in $(TARGETS); do echo "== running $$t =="; $$t || exit 1; echo; done

clean:
	rm -rf $(BUILD_DIR)
