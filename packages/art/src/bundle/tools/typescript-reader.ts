/**
 * The TypeScript projection behind the sync tool: a parsed chunk, in the shapes `predicates.ts` reads.
 *
 * This is deliberately *not* part of `@mg.js/art/bundle`'s public surface, and not reachable from it: the pure
 * entry may not import TypeScript, so the projection lives here, beside the sync that already depends on the
 * monorepo's TypeScript, and the predicates receive what this produces. A consumer with no parser writes its own
 * twenty lines instead; the vocabulary it has to fill is `shape.ts`.
 *
 * Two things are normalised here, both minifier idioms rather than game shapes (see `shape.ts`): `!0`/`!1` become
 * booleans, and a backtick literal with no substitutions becomes a string whose `quote` says so. Nothing else is
 * decided here -- this module has no opinion about which table is which.
 */

import ts from 'typescript';
import type {
  ParsedChunk,
  ShapeAssignment,
  ShapeCall,
  ShapeDeclaration,
  ShapeFunction,
  ShapeImport,
  ShapeMember,
  ShapeObjectLiteral,
  ShapeValue,
} from '../shape.js';

/** Project one chunk. `file` is the chunk's file name; `text` its whole source. */
export function projectChunk(file: string, text: string): ParsedChunk {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);

  const objects: ShapeObjectLiteral[] = [];
  const functions: ShapeFunction[] = [];
  const declarations: ShapeDeclaration[] = [];
  const assignments: ShapeAssignment[] = [];
  const imports: ShapeImport[] = [];

  const strip = (name: string): string => name.replace(/^['"`]|['"`]$/g, '');

  const project = (node: ts.Node): ShapeValue => {
    if (ts.isStringLiteral(node)) {
      return {
        kind: 'string',
        text: node.text,
        quote: node.getText(source).startsWith("'") ? 'single' : 'double',
      };
    }
    if (ts.isNoSubstitutionTemplateLiteral(node))
      return { kind: 'string', text: node.text, quote: 'template' };
    if (ts.isNumericLiteral(node))
      return { kind: 'number', text: node.getText(source), value: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'boolean', value: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'boolean', value: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return { kind: 'null' };
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      // The minifier's booleans: `!0` is true and `!1` is false.
      const operand = node.operand;
      if (ts.isNumericLiteral(operand) && (operand.text === '0' || operand.text === '1')) {
        return { kind: 'boolean', value: operand.text === '0' };
      }
      return { kind: 'other', text: node.getText(source) };
    }
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    ) {
      return { kind: 'number', text: node.getText(source), value: -Number(node.operand.text) };
    }
    if (ts.isArrayLiteralExpression(node)) {
      return { kind: 'array', items: node.elements.map((element) => project(element)) };
    }
    if (ts.isObjectLiteralExpression(node)) return { kind: 'object', object: projectObject(node) };
    if (ts.isParenthesizedExpression(node)) return project(node.expression);
    if (ts.isPropertyAccessExpression(node) || ts.isIdentifier(node)) {
      const path = chain(node);
      if (path !== null) {
        return {
          kind: 'reference',
          path,
          get text() {
            return node.getText(source);
          },
        };
      }
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const call: ShapeCall = {
        kind: 'call',
        callee: chain(node.expression)?.join('.') ?? node.expression.getText(source),
        construct: ts.isNewExpression(node),
        args: (node.arguments ?? []).map((argument) => project(argument)),
        get text() {
          return node.getText(source);
        },
      };
      return call;
    }
    return {
      kind: 'other',
      get text() {
        return node.getText(source);
      },
    };
  };

  const chain = (node: ts.Node): readonly string[] | null => {
    if (ts.isIdentifier(node)) return [node.text];
    if (ts.isPropertyAccessExpression(node)) {
      const head = chain(node.expression);
      if (head === null) return null;
      if (!ts.isIdentifier(node.name)) return null;
      return [...head, node.name.text];
    }
    if (ts.isElementAccessExpression(node)) {
      const head = chain(node.expression);
      const argument = node.argumentExpression;
      if (head === null || argument === undefined) return null;
      if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) return [...head, argument.text];
      const index = chain(argument);
      return index === null ? null : [...head, ...index];
    }
    return null;
  };

  const projectObject = (node: ts.ObjectLiteralExpression): ShapeObjectLiteral => {
    const members: ShapeMember[] = [];
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const computed = ts.isComputedPropertyName(property.name);
        const key = computed
          ? property.name.expression.getText(source)
          : strip(property.name.getText(source));
        members.push({ key, computed, value: project(property.initializer) });
      } else if (ts.isShorthandPropertyAssignment(property)) {
        members.push({
          key: property.name.text,
          computed: false,
          value: { kind: 'reference', path: [property.name.text], text: property.name.text },
        });
      }
    }
    return {
      kind: 'object',
      get name() {
        return assignedName(node);
      },
      members,
      start: node.getStart(source),
      end: node.getEnd(),
      get text() {
        return node.getText(source);
      },
    } as unknown as ShapeObjectLiteral;
  };

  const assignedName = (node: ts.Node): string | null => {
    let cursor: ts.Node | undefined = node.parent;
    while (cursor !== undefined) {
      if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) return cursor.name.text;
      if (ts.isPropertyAssignment(cursor) && ts.isIdentifier(cursor.name)) return cursor.name.text;
      cursor = cursor.parent;
    }
    return null;
  };

  const parameterNames = (node: ts.SignatureDeclaration): readonly string[] => {
    const names: string[] = [];
    for (const parameter of node.parameters)
      if (ts.isIdentifier(parameter.name)) names.push(parameter.name.text);
    return names;
  };

  /** Reads that the function does not bind itself: the closure, which is what identifies the placement one. */
  const freeNames = (node: ts.Node, ownName: string | null): readonly string[] => {
    const bound = new Set<string>();
    const read = new Set<string>();
    if (ownName !== null) bound.add(ownName);
    const bind = (name: ts.Node): void => {
      if (ts.isIdentifier(name)) bound.add(name.text);
    };
    const walk = (current: ts.Node): void => {
      if (
        ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current)
      ) {
        if (current.name !== undefined) bind(current.name);
        for (const parameter of current.parameters) bind(parameter.name);
      }
      if (ts.isVariableDeclaration(current)) bind(current.name);
      if (ts.isCatchClause(current) && current.variableDeclaration !== undefined)
        bind(current.variableDeclaration.name);
      ts.forEachChild(current, walk);
    };
    walk(node);
    const isBindingPosition = (identifier: ts.Identifier): boolean => {
      const parent = identifier.parent;
      if (parent === undefined) return true;
      if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
      if (ts.isPropertyAssignment(parent) && parent.name === identifier) return true;
      if (ts.isPropertySignature(parent) && parent.name === identifier) return true;
      if (ts.isMethodDeclaration(parent) && parent.name === identifier) return true;
      if (ts.isVariableDeclaration(parent) && parent.name === identifier) return true;
      if (ts.isParameter(parent) && parent.name === identifier) return true;
      if (ts.isBindingElement(parent) && parent.name === identifier) return true;
      if (ts.isFunctionDeclaration(parent) && parent.name === identifier) return true;
      if (ts.isFunctionExpression(parent) && parent.name === identifier) return true;
      if (ts.isLabeledStatement(parent) && parent.label === identifier) return true;
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        parent.left === identifier
      ) {
        return true;
      }
      return false;
    };
    const collect = (current: ts.Node): void => {
      if (ts.isIdentifier(current) && !isBindingPosition(current)) read.add(current.text);
      ts.forEachChild(current, collect);
    };
    collect(node);
    for (const name of bound) read.delete(name);
    // Property names and member accesses are not reads of a variable, but `name.text` of a property access is
    // an identifier node, so it was already skipped above; the sort keeps a closure record diffable.
    return [...read].sort();
  };

  const projectFunction = (
    node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  ): ShapeFunction => {
    const name =
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
        ? (node.name?.text ?? assignedName(node))
        : assignedName(node);
    // The closure is computed on first read: it walks the function's whole subtree, and the predicates ask for
    // it only of the handful of functions that divide by the reference tile -- two, in the captured build.
    let free: readonly string[] | null = null;
    const function_: ShapeFunction = {
      name,
      parameters: parameterNames(node),
      get free() {
        free ??= freeNames(node, name);
        return free;
      },
      start: node.getStart(source),
      end: node.getEnd(),
      get text() {
        return node.getText(source);
      },
    };
    return function_;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) objects.push(projectObject(node));
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      functions.push(projectFunction(node));
    }
    if (ts.isVariableStatement(node)) {
      const kind =
        (node.declarationList.flags & ts.NodeFlags.Const) !== 0
          ? 'const'
          : (node.declarationList.flags & ts.NodeFlags.Let) !== 0
            ? 'let'
            : 'var';
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        // `const <name> = <initializer>;`, with `bodyStart` marking where the initializer's own text begins, so
        // the bytes inside the wrapper are the chunk's and a fixture can cut them back out exactly. The wrapper
        // is canonical rather than faithful -- `const` whatever the chunk wrote, one space either side of `=` --
        // because what this hands back is a re-declaration: `sourceKind` records what the game said, and the
        // canonical form is what makes the placement function's assembled length comparable between builds, as
        // the plan's 923-character measurement of the v1176 closure assumes.
        const prefix = `const ${declaration.name.text} = `;
        declarations.push({
          name: declaration.name.text,
          kind: 'const',
          sourceKind: kind,
          value: project(declaration.initializer),
          text: `${prefix}${declaration.initializer.getText(source)};`,
          bodyStart: prefix.length,
          start: declaration.getStart(source),
          end: declaration.getEnd(),
          valueStart: declaration.initializer.getStart(source),
          valueEnd: declaration.initializer.getEnd(),
        });
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      declarations.push({
        name: node.name.text,
        kind: 'function',
        sourceKind: 'function',
        value: null,
        text: node.getText(source),
        bodyStart: 0,
        start: node.getStart(source),
        end: node.getEnd(),
        valueStart: node.getStart(source),
        valueEnd: node.getEnd(),
      });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const path = chain(node.left);
      if (path !== null) {
        assignments.push({
          path,
          value: project(node.right),
          start: node.getStart(source),
          end: node.getEnd(),
          get text() {
            return node.getText(source);
          },
        });
      }
    }
    if (ts.isImportDeclaration(node) && node.importClause !== undefined) {
      const from = node.moduleSpecifier.getText(source).replace(/^['"]|['"]$/g, '');
      const bindings = node.importClause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.push({
            local: element.name.text,
            imported: element.propertyName?.text ?? element.name.text,
            from,
          });
        }
      }
      if (node.importClause.name !== undefined) {
        imports.push({ local: node.importClause.name.text, imported: 'default', from });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { file, text, objects, functions, declarations, assignments, imports };
}
