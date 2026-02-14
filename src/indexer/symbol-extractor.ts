import type Parser from "web-tree-sitter";
import type {
  ExtractedSymbol,
  ImportDeclaration,
  ParsedFileResult,
  SymbolKind,
} from "../parser/queries/common.js";

/**
 * Extract symbols and imports from a parsed AST.
 * Uses recursive AST walking (works across all languages).
 */
export function extractSymbols(
  tree: Parser.Tree,
  source: string,
  language: string,
): ParsedFileResult {
  const lines = source.split("\n");
  const symbols: ExtractedSymbol[] = [];
  const imports: ImportDeclaration[] = [];

  const isTS = language === "typescript" || language === "javascript";
  const isPython = language === "python";
  const isRust = language === "rust";
  const isGo = language === "go";

  function getNodeText(node: Parser.SyntaxNode): string {
    return source.slice(node.startIndex, node.endIndex);
  }

  function getDocstring(node: Parser.SyntaxNode): string | undefined {
    // Look for comment immediately before the node
    const prevSibling = node.previousNamedSibling;
    if (!prevSibling) return undefined;

    if (prevSibling.type === "comment") {
      const text = getNodeText(prevSibling);
      // Clean JSDoc or line comment
      return text
        .replace(/^\/\*\*?\s*/, "")
        .replace(/\s*\*\/$/, "")
        .replace(/^\s*\*\s?/gm, "")
        .replace(/^\/\/\s?/gm, "")
        .trim();
    }
    return undefined;
  }

  function isExported(node: Parser.SyntaxNode): boolean {
    if (!isTS) return true; // Non-TS languages: treat top-level as exported
    const parent = node.parent;
    if (parent?.type === "export_statement") return true;
    // Check if wrapped in export
    if (parent?.type === "program") {
      // Check for 'export' keyword at same position
      const prev = node.previousSibling;
      if (prev?.type === "export") return true;
    }
    return false;
  }

  function getSignature(node: Parser.SyntaxNode, kind: SymbolKind): string {
    const text = getNodeText(node);
    if (kind === "function" || kind === "method") {
      // Get up to the opening brace or colon
      const braceIdx = text.indexOf("{");
      const arrowIdx = text.indexOf("=>");
      const endIdx =
        braceIdx >= 0
          ? braceIdx
          : arrowIdx >= 0
            ? arrowIdx + 2
            : Math.min(text.length, 200);
      return text.slice(0, endIdx).trim();
    }
    if (kind === "class" || kind === "interface") {
      const braceIdx = text.indexOf("{");
      return braceIdx >= 0 ? text.slice(0, braceIdx).trim() : text.slice(0, 200).trim();
    }
    if (kind === "type") {
      // Type alias: first line
      const newlineIdx = text.indexOf("\n");
      return newlineIdx >= 0
        ? text.slice(0, newlineIdx).trim()
        : text.slice(0, 200).trim();
    }
    return text.slice(0, 200).trim();
  }

  function walkNode(
    node: Parser.SyntaxNode,
    parentName?: string,
  ): void {
    const type = node.type;

    // TypeScript / JavaScript
    if (isTS) {
      extractTS(node, parentName);
    } else if (isPython) {
      extractPython(node, parentName);
    } else if (isRust) {
      extractRust(node, parentName);
    } else if (isGo) {
      extractGo(node, parentName);
    }
  }

  function extractTS(
    node: Parser.SyntaxNode,
    parentName?: string,
  ): void {
    const type = node.type;

    // Imports
    if (type === "import_statement") {
      const sourceNode =
        node.childForFieldName("source") ??
        node.descendantsOfType("string").at(0);
      if (sourceNode) {
        const importSource = getNodeText(sourceNode).replace(/['"]/g, "");
        const names: string[] = [];
        let isDefault = false;
        let isNamespace = false;

        for (const child of node.namedChildren) {
          if (child.type === "import_clause") {
            for (const c of child.namedChildren) {
              if (c.type === "identifier") {
                names.push(getNodeText(c));
                isDefault = true;
              }
              if (c.type === "named_imports") {
                for (const spec of c.namedChildren) {
                  if (spec.type === "import_specifier") {
                    const nameNode = spec.childForFieldName("name");
                    if (nameNode) names.push(getNodeText(nameNode));
                  }
                }
              }
              if (c.type === "namespace_import") {
                const nameNode = c.childForFieldName("name");
                if (nameNode) names.push(getNodeText(nameNode));
                isNamespace = true;
              }
            }
          }
        }

        imports.push({
          source: importSource,
          names,
          isDefault,
          isNamespace,
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    // Functions
    if (type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const exp = isExported(node) || isExported(node.parent!);
        symbols.push({
          name: getNodeText(nameNode),
          kind: "function",
          signature: getSignature(node, "function"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: exp,
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    // Arrow functions / const declarations
    if (
      type === "lexical_declaration" ||
      type === "variable_declaration"
    ) {
      for (const declarator of node.namedChildren) {
        if (declarator.type === "variable_declarator") {
          const nameNode = declarator.childForFieldName("name");
          const valueNode = declarator.childForFieldName("value");
          if (nameNode && valueNode?.type === "arrow_function") {
            const exp = isExported(node) || isExported(node.parent!);
            symbols.push({
              name: getNodeText(nameNode),
              kind: "function",
              signature: getSignature(node, "function"),
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startCol: node.startPosition.column,
              endCol: node.endPosition.column,
              parentName,
              docstring: getDocstring(node),
              exported: exp,
              bodyText: getNodeText(node),
            });
            return;
          }
        }
      }
    }

    // Classes
    if (type === "class_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const className = getNodeText(nameNode);
        const exp = isExported(node) || isExported(node.parent!);
        symbols.push({
          name: className,
          kind: "class",
          signature: getSignature(node, "class"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: exp,
          bodyText: getNodeText(node),
        });

        // Extract methods
        const body = node.childForFieldName("body");
        if (body) {
          for (const member of body.namedChildren) {
            if (member.type === "method_definition") {
              const methodName = member.childForFieldName("name");
              if (methodName) {
                symbols.push({
                  name: getNodeText(methodName),
                  kind: "method",
                  signature: getSignature(member, "method"),
                  startLine: member.startPosition.row + 1,
                  endLine: member.endPosition.row + 1,
                  startCol: member.startPosition.column,
                  endCol: member.endPosition.column,
                  parentName: className,
                  docstring: getDocstring(member),
                  exported: exp,
                  bodyText: getNodeText(member),
                });
              }
            }
            if (member.type === "public_field_definition" || member.type === "property_definition") {
              const propName = member.childForFieldName("name");
              if (propName) {
                symbols.push({
                  name: getNodeText(propName),
                  kind: "property",
                  signature: getNodeText(member).slice(0, 200),
                  startLine: member.startPosition.row + 1,
                  endLine: member.endPosition.row + 1,
                  startCol: member.startPosition.column,
                  endCol: member.endPosition.column,
                  parentName: className,
                  docstring: undefined,
                  exported: exp,
                  bodyText: getNodeText(member),
                });
              }
            }
          }
        }
        return; // Don't recurse into class body (already handled)
      }
    }

    // Interfaces
    if (type === "interface_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const exp = isExported(node) || isExported(node.parent!);
        symbols.push({
          name: getNodeText(nameNode),
          kind: "interface",
          signature: getSignature(node, "interface"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: exp,
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    // Type aliases
    if (type === "type_alias_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const exp = isExported(node) || isExported(node.parent!);
        symbols.push({
          name: getNodeText(nameNode),
          kind: "type",
          signature: getSignature(node, "type"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: exp,
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    // Enums
    if (type === "enum_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const exp = isExported(node) || isExported(node.parent!);
        symbols.push({
          name: getNodeText(nameNode),
          kind: "enum",
          signature: getSignature(node, "type"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: exp,
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    // Export statement: recurse into children
    if (type === "export_statement") {
      for (const child of node.namedChildren) {
        walkNode(child, parentName);
      }
      return;
    }

    // Recurse for program/module level
    if (type === "program" || type === "module") {
      for (const child of node.namedChildren) {
        walkNode(child, parentName);
      }
      return;
    }
  }

  function extractPython(
    node: Parser.SyntaxNode,
    parentName?: string,
  ): void {
    const type = node.type;

    if (type === "import_statement" || type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name") ??
        node.descendantsOfType("dotted_name").at(0);
      if (moduleNode) {
        const source = getNodeText(moduleNode);
        const names: string[] = [];
        for (const child of node.namedChildren) {
          if (child.type === "aliased_import" || child.type === "dotted_name") {
            const nameNode = child.childForFieldName("name") ?? child;
            names.push(getNodeText(nameNode));
          }
        }
        imports.push({
          source,
          names,
          isDefault: false,
          isNamespace: false,
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    if (type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = getNodeText(nameNode);
        const kind: SymbolKind = parentName ? "method" : "function";
        // Get docstring from function body
        const body = node.childForFieldName("body");
        let docstring: string | undefined;
        if (body?.firstNamedChild?.type === "expression_statement") {
          const expr = body.firstNamedChild.firstNamedChild;
          if (expr?.type === "string") {
            docstring = getNodeText(expr)
              .replace(/^['"]{3}/, "")
              .replace(/['"]{3}$/, "")
              .trim();
          }
        }

        symbols.push({
          name,
          kind,
          signature: getSignature(node, kind),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring,
          exported: !name.startsWith("_"),
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    if (type === "class_definition") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const className = getNodeText(nameNode);
        symbols.push({
          name: className,
          kind: "class",
          signature: getSignature(node, "class"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: !className.startsWith("_"),
          bodyText: getNodeText(node),
        });

        // Extract methods
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === "function_definition") {
              extractPython(child, className);
            }
          }
        }
        return;
      }
    }

    // Recurse for module level
    if (type === "module") {
      for (const child of node.namedChildren) {
        extractPython(child, parentName);
      }
    }
  }

  function extractRust(
    node: Parser.SyntaxNode,
    parentName?: string,
  ): void {
    const type = node.type;

    if (type === "use_declaration") {
      const pathNode = node.descendantsOfType("scoped_identifier").at(0) ??
        node.descendantsOfType("identifier").at(0);
      if (pathNode) {
        imports.push({
          source: getNodeText(pathNode),
          names: [],
          isDefault: false,
          isNamespace: false,
          line: node.startPosition.row + 1,
        });
      }
      return;
    }

    if (type === "function_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const isPublic = node.children.some(
          (c) => c.type === "visibility_modifier",
        );
        symbols.push({
          name: getNodeText(nameNode),
          kind: parentName ? "method" : "function",
          signature: getSignature(node, "function"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: isPublic,
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    if (type === "struct_item" || type === "enum_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push({
          name: getNodeText(nameNode),
          kind: type === "struct_item" ? "class" : "enum",
          signature: getSignature(node, "class"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: node.children.some(
            (c) => c.type === "visibility_modifier",
          ),
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    if (type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      const implName = typeNode ? getNodeText(typeNode) : undefined;
      const body = node.childForFieldName("body");
      if (body) {
        for (const child of body.namedChildren) {
          extractRust(child, implName);
        }
      }
      return;
    }

    if (type === "trait_item") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        symbols.push({
          name: getNodeText(nameNode),
          kind: "interface",
          signature: getSignature(node, "interface"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: node.children.some(
            (c) => c.type === "visibility_modifier",
          ),
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    if (type === "source_file") {
      for (const child of node.namedChildren) {
        extractRust(child, parentName);
      }
    }
  }

  function extractGo(
    node: Parser.SyntaxNode,
    parentName?: string,
  ): void {
    const type = node.type;

    if (type === "import_declaration") {
      for (const spec of node.descendantsOfType("import_spec")) {
        const pathNode = spec.childForFieldName("path");
        if (pathNode) {
          imports.push({
            source: getNodeText(pathNode).replace(/"/g, ""),
            names: [],
            isDefault: false,
            isNamespace: false,
            line: spec.startPosition.row + 1,
          });
        }
      }
      return;
    }

    if (type === "function_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        const name = getNodeText(nameNode);
        symbols.push({
          name,
          kind: "function",
          signature: getSignature(node, "function"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName,
          docstring: getDocstring(node),
          exported: name[0] === name[0].toUpperCase(),
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    if (type === "method_declaration") {
      const nameNode = node.childForFieldName("name");
      const receiverNode = node.childForFieldName("receiver");
      if (nameNode) {
        const name = getNodeText(nameNode);
        const receiver = receiverNode
          ? getNodeText(receiverNode)
              .replace(/[()]/g, "")
              .split(/\s+/)
              .pop()
              ?.replace("*", "")
          : undefined;
        symbols.push({
          name,
          kind: "method",
          signature: getSignature(node, "method"),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startCol: node.startPosition.column,
          endCol: node.endPosition.column,
          parentName: receiver,
          docstring: getDocstring(node),
          exported: name[0] === name[0].toUpperCase(),
          bodyText: getNodeText(node),
        });
      }
      return;
    }

    if (type === "type_declaration") {
      for (const spec of node.namedChildren) {
        if (spec.type === "type_spec") {
          const nameNode = spec.childForFieldName("name");
          const typeNode = spec.childForFieldName("type");
          if (nameNode) {
            const name = getNodeText(nameNode);
            const kind: SymbolKind =
              typeNode?.type === "struct_type"
                ? "class"
                : typeNode?.type === "interface_type"
                  ? "interface"
                  : "type";
            symbols.push({
              name,
              kind,
              signature: getSignature(spec, kind),
              startLine: spec.startPosition.row + 1,
              endLine: spec.endPosition.row + 1,
              startCol: spec.startPosition.column,
              endCol: spec.endPosition.column,
              parentName,
              docstring: getDocstring(node),
              exported: name[0] === name[0].toUpperCase(),
              bodyText: getNodeText(spec),
            });
          }
        }
      }
      return;
    }

    if (type === "source_file") {
      for (const child of node.namedChildren) {
        extractGo(child, parentName);
      }
    }
  }

  walkNode(tree.rootNode);

  return { symbols, imports };
}
