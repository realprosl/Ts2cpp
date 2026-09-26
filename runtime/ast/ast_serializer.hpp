#pragma once

#include <string>
#include "runtime/ast/ast_nodes.hpp"
#include "runtime/ets_syntax.hpp"

namespace ets::ast {

inline std::string serializeJson(const Module& module) {
    std::string output = "{\"root\":" + std::to_string(module.root) + ",\"nodes\":[";
    for (std::size_t index = 0; index < module.nodes.size(); ++index) {
        if (index != 0) output += ',';
        const auto& node = module.nodes[index];
        output += "{\"id\":" + std::to_string(index) +
                  ",\"kind\":\"" + syntaxJsonEscape(nodeKindName(node.kind)) +
                  "\",\"sourceKind\":\"" + syntaxJsonEscape(node.sourceKind) +
                  "\",\"start\":" + std::to_string(node.span.start) +
                  ",\"end\":" + std::to_string(node.span.end) +
                  ",\"line\":" + std::to_string(node.span.line) +
                  ",\"column\":" + std::to_string(node.span.column) +
                  ",\"name\":\"" + syntaxJsonEscape(node.name) +
                  "\",\"value\":\"" + syntaxJsonEscape(node.value) +
                  "\",\"operator\":\"" + syntaxJsonEscape(node.operation) +
                  "\",\"declaredType\":\"" + syntaxJsonEscape(node.declaredType.name) +
                  "\",\"inferredType\":\"" + syntaxJsonEscape(node.inferredType.name) +
                  "\",\"exported\":" + (node.exported ? "true" : "false") +
                  ",\"mutable\":" + (node.mutableValue ? "true" : "false") +
                  ",\"async\":" + (node.asynchronous ? "true" : "false") +
                  ",\"out\":" + (node.output ? "true" : "false") +
                  ",\"mut\":" + (node.mutableReference ? "true" : "false") +
                  ",\"variadic\":" + (node.variadic ? "true" : "false") +
                  ",\"children\":[";
        for (std::size_t childIndex = 0; childIndex < node.children.size(); ++childIndex) {
            if (childIndex != 0) output += ',';
            const auto& edge = node.children[childIndex];
            output += "{\"role\":\"" + syntaxJsonEscape(edge.role) + "\",\"node\":" + std::to_string(edge.node) + "}";
        }
        output += "]}";
    }
    return output + "]}";
}

inline std::string recordEscape(std::string_view value) {
    std::string output;
    for (const char character : value) {
        if (character == '\\') output += "\\\\";
        else if (character == '|') output += "\\p";
        else if (character == '\n') output += "\\n";
        else if (character == '\r') output += "\\r";
        else output += character;
    }
    return output;
}

// id|parent|role|kind|line|start|end|name|declared|inferred|operator|flags|value|
inline std::string serializeRecords(const Module& module) {
    std::vector<std::int64_t> parents(module.nodes.size(), -1);
    std::vector<std::string> roles(module.nodes.size());
    for (std::size_t parent = 0; parent < module.nodes.size(); ++parent) {
        for (const auto& edge : module.nodes[parent].children) { parents[edge.node] = static_cast<std::int64_t>(parent); roles[edge.node] = edge.role; }
    }
    std::string output;
    for (std::size_t id = 0; id < module.nodes.size(); ++id) {
        if (id != 0) output += '\n';
        const auto& node = module.nodes[id];
        std::string flags;
        if (node.exported) flags += 'E'; if (node.mutableValue) flags += 'M'; if (node.asynchronous) flags += 'A'; if (node.output) flags += 'O'; if (node.mutableReference) flags += 'U'; if (node.variadic) flags += 'V';
        output += std::to_string(id) + "|" + std::to_string(parents[id]) + "|" + recordEscape(roles[id]) + "|" + nodeKindName(node.kind) + "|" +
                  std::to_string(node.span.line) + "|" + std::to_string(node.span.start) + "|" + std::to_string(node.span.end) + "|" +
                  recordEscape(node.name) + "|" + recordEscape(node.declaredType.name) + "|" + recordEscape(node.inferredType.name) + "|" +
                  recordEscape(node.operation) + "|" + flags + "|" + recordEscape(node.value) + "|";
    }
    return output;
}

} // namespace ets::ast
