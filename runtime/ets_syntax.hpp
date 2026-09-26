#pragma once

#include <cctype>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "third_party/tree-sitter/include/tree_sitter/api.h"

extern "C" const TSLanguage* tree_sitter_typescript(void);

namespace ets {

struct SyntaxChild {
    std::uint32_t node = 0;
    std::string field;
};

struct SyntaxNode {
    std::string kind;
    std::uint32_t startByte = 0;
    std::uint32_t endByte = 0;
    std::uint32_t startLine = 0;
    std::uint32_t startColumn = 0;
    std::uint32_t endLine = 0;
    std::uint32_t endColumn = 0;
    bool error = false;
    bool missing = false;
    std::vector<SyntaxChild> children;
};

struct SyntaxTree {
    std::uint32_t root = 0;
    std::vector<SyntaxNode> nodes;
};

inline std::string syntaxJsonEscape(std::string_view value) {
    std::string output;
    output.reserve(value.size());
    constexpr char hex[] = "0123456789abcdef";
    for (const unsigned char character : value) {
        switch (character) {
            case '\"': output += "\\\""; break;
            case '\\': output += "\\\\"; break;
            case '\b': output += "\\b"; break;
            case '\f': output += "\\f"; break;
            case '\n': output += "\\n"; break;
            case '\r': output += "\\r"; break;
            case '\t': output += "\\t"; break;
            default:
                if (character < 0x20) {
                    output += "\\u00";
                    output += hex[(character >> 4) & 0x0f];
                    output += hex[character & 0x0f];
                } else output += static_cast<char>(character);
        }
    }
    return output;
}

inline std::uint32_t appendSyntaxNode(TSNode native, SyntaxTree& tree) {
    const std::uint32_t id = static_cast<std::uint32_t>(tree.nodes.size());
    const TSPoint start = ts_node_start_point(native);
    const TSPoint end = ts_node_end_point(native);
    tree.nodes.push_back({ts_node_type(native), ts_node_start_byte(native), ts_node_end_byte(native),
                          start.row + 1, start.column + 1, end.row + 1, end.column + 1,
                          ts_node_is_error(native), ts_node_is_missing(native), {}});
    const std::uint32_t count = ts_node_child_count(native);
    for (std::uint32_t index = 0; index < count; ++index) {
        const TSNode child = ts_node_child(native, index);
        if (!ts_node_is_named(child)) continue;
        const char* field = ts_node_field_name_for_child(native, index);
        const std::uint32_t childId = appendSyntaxNode(child, tree);
        tree.nodes[id].children.push_back({childId, field == nullptr ? "" : field});
    }
    return id;
}

inline const SyntaxNode* firstInvalidNode(const SyntaxTree& tree) {
    for (const auto& node : tree.nodes) if (node.error || node.missing) return &node;
    return nullptr;
}

inline const SyntaxNode* firstForbiddenNode(const SyntaxTree& tree, std::string& message) {
    for (const auto& node : tree.nodes) {
        if (node.kind == "throw_statement") { message = "'throw' no está permitido; utilice Result<T>"; return &node; }
        if (node.kind == "try_statement") { message = "'try/catch/finally' no está permitido; utilice Result<T>"; return &node; }
        if (node.kind == "class_heritage") { message = "las clases no admiten herencia; utilice composición"; return &node; }
        if (node.kind == "extends_type_clause") { message = "las interfaces no admiten herencia; utilice composición de contratos"; return &node; }
    }
    return nullptr;
}

inline std::string normalizeEstaticSyntax(const std::string& source) {
    std::string output = source;
    bool quoted = false;
    char quote = '\0';
    bool lineComment = false;
    bool blockComment = false;
    for (std::size_t index = 0; index < output.size(); ++index) {
        const char current = output[index];
        const char next = index + 1 < output.size() ? output[index + 1] : '\0';
        if (lineComment) { if (current == '\n') lineComment = false; continue; }
        if (blockComment) { if (current == '*' && next == '/') { blockComment = false; ++index; } continue; }
        if (quoted) {
            if (current == '\\') { ++index; continue; }
            if (current == quote) quoted = false;
            continue;
        }
        if (current == '/' && next == '/') { lineComment = true; ++index; continue; }
        if (current == '/' && next == '*') { blockComment = true; ++index; continue; }
        if (current == '\"' || current == '\'') { quoted = true; quote = current; continue; }
        const bool leftBoundary = index == 0 || !(std::isalnum(static_cast<unsigned char>(output[index - 1])) || output[index - 1] == '_');
        const bool rightBoundary = index + 3 >= output.size() || !(std::isalnum(static_cast<unsigned char>(output[index + 3])) || output[index + 3] == '_');
        if (leftBoundary && rightBoundary && (output.compare(index, 3, "out") == 0 || output.compare(index, 3, "mut") == 0)) {
            output.replace(index, 3, "   "); index += 2; continue;
        }
        if (current == '<') {
            std::size_t cursor = index + 1;
            while (cursor < output.size() && std::isspace(static_cast<unsigned char>(output[cursor]))) ++cursor;
            if (output.compare(cursor, 3, "...") == 0) output.replace(cursor, 3, "   ");
        }
    }
    return output;
}

inline bool parseEstaticSyntax(const std::string& source, SyntaxTree& output, std::string& error) noexcept {
    TSParser* parser = ts_parser_new();
    if (parser == nullptr) { error = "No se pudo crear el parser Tree-sitter"; return false; }
    if (!ts_parser_set_language(parser, tree_sitter_typescript())) {
        ts_parser_delete(parser); error = "La gramática TypeScript no es compatible con el runtime Tree-sitter"; return false;
    }
    const std::string normalized = normalizeEstaticSyntax(source);
    TSTree* nativeTree = ts_parser_parse_string(parser, nullptr, normalized.data(), static_cast<std::uint32_t>(normalized.size()));
    ts_parser_delete(parser);
    if (nativeTree == nullptr) { error = "Tree-sitter no pudo construir el árbol sintáctico"; return false; }
    output.nodes.clear();
    output.root = appendSyntaxNode(ts_tree_root_node(nativeTree), output);
    ts_tree_delete(nativeTree);
    if (const auto* invalid = firstInvalidNode(output)) {
        error = "Error sintáctico en " + std::to_string(invalid->startLine) + ":" + std::to_string(invalid->startColumn) + " cerca de '" + invalid->kind + "'";
        return false;
    }
    std::string forbidden;
    if (const auto* invalid = firstForbiddenNode(output, forbidden)) {
        error = "Error sintáctico en " + std::to_string(invalid->startLine) + ":" + std::to_string(invalid->startColumn) + ": " + forbidden;
        return false;
    }
    return true;
}

inline std::string serializeSyntaxTree(const SyntaxTree& tree, const std::string& source) {
    std::string output = "{\"root\":" + std::to_string(tree.root) + ",\"nodes\":[";
    for (std::size_t index = 0; index < tree.nodes.size(); ++index) {
        if (index != 0) output += ',';
        const auto& node = tree.nodes[index];
        const std::string_view text(source.data() + node.startByte, node.endByte - node.startByte);
        output += "{\"id\":" + std::to_string(index) + ",\"kind\":\"" + syntaxJsonEscape(node.kind) +
                  "\",\"start\":" + std::to_string(node.startByte) + ",\"end\":" + std::to_string(node.endByte) +
                  ",\"line\":" + std::to_string(node.startLine) + ",\"column\":" + std::to_string(node.startColumn) +
                  ",\"text\":\"" + syntaxJsonEscape(text) + "\",\"children\":[";
        for (std::size_t childIndex = 0; childIndex < node.children.size(); ++childIndex) {
            if (childIndex != 0) output += ',';
            const auto& child = node.children[childIndex];
            output += "{\"field\":\"" + syntaxJsonEscape(child.field) + "\",\"node\":" + std::to_string(child.node) + "}";
        }
        output += "]}";
    }
    return output + "]}";
}

inline std::string serializeSyntaxRecords(const SyntaxTree& tree) {
    std::vector<std::int64_t> parents(tree.nodes.size(), -1);
    std::vector<std::string> fields(tree.nodes.size());
    for (std::size_t parent = 0; parent < tree.nodes.size(); ++parent) {
        for (const auto& child : tree.nodes[parent].children) {
            parents[child.node] = static_cast<std::int64_t>(parent);
            fields[child.node] = child.field;
        }
    }
    std::string output;
    for (std::size_t index = 0; index < tree.nodes.size(); ++index) {
        if (index != 0) output += '\n';
        const auto& node = tree.nodes[index];
        output += std::to_string(index) + "|" + std::to_string(parents[index]) + "|" + fields[index] + "|" + node.kind + "|" +
                  std::to_string(node.startByte) + "|" + std::to_string(node.endByte) + "|" +
                  std::to_string(node.startLine) + "|" + std::to_string(node.startColumn);
    }
    return output;
}

} // namespace ets

inline bool validateSyntax(const std::string& source, std::string& error) noexcept {
    ets::SyntaxTree tree;
    return ets::parseEstaticSyntax(source, tree, error);
}

inline bool syntaxTreeJson(const std::string& source, std::string& output, std::string& error) noexcept {
    ets::SyntaxTree tree;
    if (!ets::parseEstaticSyntax(source, tree, error)) return false;
    output = ets::serializeSyntaxTree(tree, source);
    return true;
}

inline bool syntaxTreeRecords(const std::string& source, std::string& output, std::string& error) noexcept {
    ets::SyntaxTree tree;
    if (!ets::parseEstaticSyntax(source, tree, error)) return false;
    output = ets::serializeSyntaxRecords(tree);
    return true;
}
