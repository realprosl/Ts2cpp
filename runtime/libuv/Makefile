# Validador de la arquitectura libuv → corutinas C++20.
#
# No es parte del runtime de Ts2cpp. Es standalone, sirve para validar
# la Fase 1 antes de tocar el EventLoop real.
#
# Uso:
#   cd runtime/libuv && make
#   ./build/validate_architecture

CXX      ?= g++
CXXFLAGS ?= -std=c++20 -O2 -Wall -Wextra
LDLIBS   ?= -luv

BUILD_DIR = build
SOURCES   = validate_architecture.cpp
TARGETS   = $(BUILD_DIR)/validate_architecture

.PHONY: all clean run

all: $(TARGETS)

$(BUILD_DIR)/validate_architecture: $(SOURCES) | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -o $@ $< $(LDLIBS)

$(BUILD_DIR):
	mkdir -p $@

run: $(TARGETS)
	$(TARGETS)

clean:
	rm -rf $(BUILD_DIR)
