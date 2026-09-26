#pragma once

#include <charconv>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

namespace ets {

// Concatena cualquier número de partes heterogéneas en un único `std::string`.
// Usa `operator<<` para que partes como `double`/`bool` se conviertan vía su
// sobrecarga de stream (necesario para soportar template literals con números).
template <typename... Parts>
std::string concat(const Parts&... parts) {
    std::ostringstream oss;
    (oss << ... << parts);
    return oss.str();
}

} // namespace ets

inline double length(const std::string& value) { return static_cast<double>(value.size()); }
template <typename T>
inline double length(const std::vector<T>& value) { return static_cast<double>(value.size()); }
template <typename... T>
inline double length(const std::tuple<T...>&) { return static_cast<double>(sizeof...(T)); }

inline std::string numberToString(double value) {
    char buffer[64];
    const auto converted = std::to_chars(buffer, buffer + sizeof(buffer), value);
    return converted.ec == std::errc{} ? std::string(buffer, converted.ptr) : std::string();
}

inline std::string charAt(const std::string& value, double index) {
    const auto i = static_cast<std::size_t>(index);
    return i < value.size() ? std::string(1, value[i]) : std::string();
}

inline std::string substring(const std::string& value, double start, double end) {
    const auto first = static_cast<std::size_t>(start);
    const auto last = static_cast<std::size_t>(end);
    if (first >= value.size() || last <= first) return std::string();
    return value.substr(first, last - first);
}

inline double indexOf(const std::string& value, const std::string& needle, double start) {
    const auto found = value.find(needle, static_cast<std::size_t>(start));
    return found == std::string::npos ? -1.0 : static_cast<double>(found);
}

inline bool startsWith(const std::string& value, const std::string& prefix) {
    return value.starts_with(prefix);
}

inline std::string trim(const std::string& value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return std::string();
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

inline double lineCount(const std::string& value) {
    double count = 1;
    for (char c : value) if (c == '\n') count++;
    return count;
}

inline std::string lineAt(const std::string& value, double requested) {
    const auto target = static_cast<std::size_t>(requested);
    std::size_t line = 0;
    std::size_t start = 0;
    for (std::size_t i = 0; i <= value.size(); i++) {
        if (i == value.size() || value[i] == '\n') {
            if (line == target) {
                std::size_t end = i;
                if (end > start && value[end - 1] == '\r') end--;
                return value.substr(start, end - start);
            }
            line++;
            start = i + 1;
        }
    }
    return std::string();
}
