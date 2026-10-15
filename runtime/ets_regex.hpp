// V30.25: regex literals y operaciones (test/match/replace).
// Envuelve `std::regex` (C++11) en un struct opaco `ets_regex`.
//
// Uso desde el dialecto:
//
//   const r: Regex = regex("\\d+")
//   r.test("a1b2")         // true
//   r.match("a1b2")        // ["1", "2"]
//   r.replace("a1b2", "X") // "aXbX"
//
// El struct es move-only y lightweight (envuelve `std::regex`).
// Comparar dos `ets_regex` con `operator==` compara los patterns y flags.

#pragma once

#include <regex>
#include <string>
#include <vector>

namespace ets {

struct ets_regex {
    std::regex re;
    std::string pattern;
    std::string flags;

    ets_regex() = default;
    ets_regex(std::string p, std::string f) : re(p, parse_flags(f)), pattern(std::move(p)), flags(std::move(f)) {}

    static std::regex::flag_type parse_flags(const std::string& f) {
        std::regex::flag_type out = std::regex::ECMAScript;
        for (char c : f) {
            if (c == 'i') out |= std::regex::icase;
            else if (c == 'm') out |= std::regex::multiline;
            // ECMAScript es el default; no soportamos 'g' (en C++ match es
            // greedy por defecto) ni 's' (ECMAScript no distingue . de \n).
        }
        return out;
    }

    // V30.25: `test(s)` devuelve true si el pattern matchea en `s`.
    bool test(const std::string& s) const {
        return std::regex_search(s, re);
    }

    // V30.25: `match(s)` devuelve TODOS los matches no solapados en `s`.
    // Si no hay matches, devuelve un vector vacio. Cada elemento del
    // vector es el texto del match completo (no los grupos de captura).
    std::vector<std::string> match(const std::string& s) const {
        std::vector<std::string> out;
        auto begin = std::sregex_iterator(s.begin(), s.end(), re);
        auto end = std::sregex_iterator();
        for (auto it = begin; it != end; ++it) {
            out.push_back((*it)[0].str());
        }
        return out;
    }

    // V30.25: `replace(s, repl)` reemplaza el primer match por `repl`.
    // Soporta los back-references clasicos: `$0` (match completo) y
    // `$1`..`$9` (grupo 1..9). Implementacion manual para evitar
    // diferencias entre implementaciones de `std::regex_replace`.
    std::string replace(const std::string& s, const std::string& repl) const {
        std::smatch m;
        if (!std::regex_search(s, m, re)) return s;
        std::string out;
        out.reserve(s.size() + repl.size());
        size_t pos = 0;
        size_t match_start = static_cast<size_t>(m.position(0));
        size_t match_len = static_cast<size_t>(m.length(0));
        out.append(s, pos, match_start - pos);
        // Expandir back-references en `repl`.
        for (size_t i = 0; i < repl.size(); ++i) {
            if (repl[i] == '$' && i + 1 < repl.size()) {
                char next = repl[i + 1];
                if (next >= '0' && next <= '9') {
                    size_t group = next - '0';
                    if (group < m.size()) {
                        out.append(m[group].str());
                        ++i;
                        continue;
                    }
                }
            }
            out.push_back(repl[i]);
        }
        pos = match_start + match_len;
        out.append(s, pos, std::string::npos);
        return out;
    }
};

// Constructor: `regex(pattern)` y `regex(pattern, flags)`.
inline ets_regex regex(const std::string& pattern) {
    return ets_regex(pattern, std::string());
}
inline ets_regex regex(const std::string& pattern, const std::string& flags) {
    return ets_regex(pattern, flags);
}

}  // namespace ets
