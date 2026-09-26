; inherits: typescript

"mut" @keyword.modifier
"out" @keyword.modifier

(required_parameter
  modifier: (parameter_modifier) @keyword.modifier)

(function_declaration name: (identifier) @function)
(method_definition name: (property_identifier) @function.method)
(class_declaration name: (type_identifier) @type)
(interface_declaration name: (type_identifier) @type.interface)
