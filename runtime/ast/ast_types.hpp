#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace ets::ast {

enum class TypeKind { Unknown, Number, String, Boolean, Void, Named, Array, Tuple, Function, Generic };

struct Type {
    TypeKind kind = TypeKind::Unknown;
    std::string name = "unknown";
    std::vector<Type> arguments;
};

inline Type parseType(std::string_view text) {
    Type result;
    while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == ':')) text.remove_prefix(1);
    while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' || text.back() == '\n')) text.remove_suffix(1);
    result.name = std::string(text);
    if (text.empty()) return result;
    if (text == "number") result.kind = TypeKind::Number;
    else if (text == "string") result.kind = TypeKind::String;
    else if (text == "boolean") result.kind = TypeKind::Boolean;
    else if (text == "void") result.kind = TypeKind::Void;
    else if (text.size() > 2 && text.substr(text.size() - 2) == "[]") {
        result.kind = TypeKind::Array;
        result.arguments.push_back(parseType(text.substr(0, text.size() - 2)));
    } else if (text.front() == '[' && text.back() == ']') {
        result.kind = TypeKind::Tuple;
        std::size_t start = 1, depth = 0;
        for (std::size_t i = 1; i < text.size(); ++i) {
            const char c = text[i];
            if (c == '<' || c == '[' || c == '(') ++depth;
            if (c == '>' || c == ']' || c == ')') { if (depth > 0) --depth; }
            if ((c == ',' && depth == 0) || i + 1 == text.size()) {
                result.arguments.push_back(parseType(text.substr(start, i - start)));
                start = i + 1;
            }
        }
    } else {
        const auto open = text.find('<');
        if (open != std::string_view::npos && text.back() == '>') {
            result.kind = TypeKind::Generic;
            std::size_t start = open + 1, depth = 0;
            for (std::size_t i = start; i < text.size(); ++i) {
                const char c = text[i];
                if (c == '<' || c == '[' || c == '(') ++depth;
                if (c == '>' || c == ']' || c == ')') { if (depth > 0) --depth; }
                if ((c == ',' && depth == 0) || i + 1 == text.size()) {
                    result.arguments.push_back(parseType(text.substr(start, i - start)));
                    start = i + 1;
                }
            }
        } else if (text.find("=>") != std::string_view::npos) result.kind = TypeKind::Function;
        else result.kind = TypeKind::Named;
    }
    return result;
}

inline std::string unwrapGeneric(std::string_view type, std::string_view base) {
    if (type.size() > base.size() + 2 && type.substr(0, base.size()) == base && type[base.size()] == '<' && type.back() == '>')
        return std::string(type.substr(base.size() + 1, type.size() - base.size() - 2));
    return "unknown";
}

} // namespace ets::ast
