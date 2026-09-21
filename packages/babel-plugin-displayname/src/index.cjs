// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// References (visitor patterns): @regrapes/babel-plugin-add-react-memo-displayname,
//   @prisma-capacity/babel-plugin-react-display-name, @zendesk/babel-plugin-react-displayname.
// Hand-rolled here so we own the forwardRef + memo + arrow + class matrix end-to-end.

/**
 * @typedef {object} PluginOptions
 * @property {string[]=} factories
 * @property {boolean=} debug
 */

/** @param {{ types: typeof import('@babel/types') }} babel */
module.exports = function babelPluginDisplayName(babel) {
  const { types: t } = babel;
  const REACT_FACTORIES = new Set(['forwardRef', 'memo']);
  const REACT_BASE_CLASSES = new Set(['Component', 'PureComponent']);

  function isReactFactoryCall(node, extraFactories) {
    if (!t.isCallExpression(node)) return false;
    const callee = node.callee;
    if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) {
      return REACT_FACTORIES.has(callee.property.name) || extraFactories.has(callee.property.name);
    }
    if (t.isIdentifier(callee)) {
      return REACT_FACTORIES.has(callee.name) || extraFactories.has(callee.name);
    }
    return false;
  }

  function isFactoryOrNestedFactory(node, extraFactories) {
    if (isReactFactoryCall(node, extraFactories)) return true;
    return false;
  }

  // PascalCase: starts uppercase, has at least one lowercase char (excludes SCREAMING_CASE).
  function isPascalCase(name) {
    return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
  }

  // Returns true if the expression position can yield a JSX node.
  function expressionYieldsJSX(node) {
    if (!node) return false;
    if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
    if (t.isConditionalExpression(node)) {
      return expressionYieldsJSX(node.consequent) || expressionYieldsJSX(node.alternate);
    }
    if (t.isLogicalExpression(node)) {
      return expressionYieldsJSX(node.left) || expressionYieldsJSX(node.right);
    }
    if (t.isSequenceExpression(node)) {
      const last = node.expressions[node.expressions.length - 1];
      return expressionYieldsJSX(last);
    }
    // TS assertions — usually stripped by preset-typescript before this runs, but be safe.
    if (t.isTSAsExpression && t.isTSAsExpression(node)) {
      return expressionYieldsJSX(node.expression);
    }
    if (t.isTSTypeAssertion && t.isTSTypeAssertion(node)) {
      return expressionYieldsJSX(node.expression);
    }
    return false;
  }

  // Scan a function body for a return statement whose argument yields JSX.
  // Critically, does NOT descend into nested functions — their returns belong to them.
  function functionReturnsJSX(fnNode) {
    if (!fnNode) return false;
    // Expression-body arrow: `(x) => <View/>`
    if (t.isArrowFunctionExpression(fnNode) && !t.isBlockStatement(fnNode.body)) {
      return expressionYieldsJSX(fnNode.body);
    }
    if (!t.isBlockStatement(fnNode.body)) return false;
    return blockHasJSXReturn(fnNode.body);
  }

  function blockHasJSXReturn(block) {
    for (const stmt of block.body) {
      if (statementHasJSXReturn(stmt)) return true;
    }
    return false;
  }

  function statementHasJSXReturn(stmt) {
    if (!stmt) return false;
    if (t.isReturnStatement(stmt)) {
      return stmt.argument ? expressionYieldsJSX(stmt.argument) : false;
    }
    if (t.isBlockStatement(stmt)) return blockHasJSXReturn(stmt);
    if (t.isIfStatement(stmt)) {
      return statementHasJSXReturn(stmt.consequent) || statementHasJSXReturn(stmt.alternate);
    }
    if (t.isSwitchStatement(stmt)) {
      return stmt.cases.some((c) => c.consequent.some(statementHasJSXReturn));
    }
    if (t.isTryStatement(stmt)) {
      return (
        statementHasJSXReturn(stmt.block) ||
        (stmt.handler && statementHasJSXReturn(stmt.handler.body)) ||
        statementHasJSXReturn(stmt.finalizer)
      );
    }
    if (t.isForStatement(stmt) || t.isForInStatement(stmt) || t.isForOfStatement(stmt) ||
        t.isWhileStatement(stmt) || t.isDoWhileStatement(stmt) || t.isLabeledStatement(stmt)) {
      return statementHasJSXReturn(stmt.body);
    }
    // Do NOT recurse into FunctionDeclaration / FunctionExpression / ArrowFunctionExpression bodies —
    // a return inside a nested function is not this function's return.
    return false;
  }

  function isInlineComponentInit(initNode) {
    if (!t.isArrowFunctionExpression(initNode) && !t.isFunctionExpression(initNode)) return false;
    return functionReturnsJSX(initNode);
  }

  function extendsReactBaseClass(superClass) {
    if (!superClass) return false;
    if (t.isIdentifier(superClass)) {
      return REACT_BASE_CLASSES.has(superClass.name);
    }
    if (t.isMemberExpression(superClass) && t.isIdentifier(superClass.property)) {
      // React.Component / React.PureComponent (and any namespace alias like Foo.Component)
      return REACT_BASE_CLASSES.has(superClass.property.name);
    }
    return false;
  }

  function hasStaticDisplayName(classNode) {
    return classNode.body.body.some((member) => {
      if (!member.static) return false;
      if (t.isClassProperty(member) && t.isIdentifier(member.key, { name: 'displayName' })) return true;
      if (t.isClassMethod(member) && t.isIdentifier(member.key, { name: 'displayName' })) return true;
      return false;
    });
  }

  function makeDisplayNameAssignment(name) {
    return t.expressionStatement(
      t.assignmentExpression(
        '=',
        t.memberExpression(t.identifier(name), t.identifier('displayName')),
        t.stringLiteral(name)
      )
    );
  }

  return {
    name: '@traceitx/babel-plugin-displayname',
    visitor: {
      VariableDeclarator(path, state) {
        const opts = state.opts || {};
        const extraFactories = new Set(opts.factories || []);
        if (!t.isIdentifier(path.node.id)) return;
        const name = path.node.id.name;
        const init = path.node.init;
        if (!init) return;

        const isFactory = isFactoryOrNestedFactory(init, extraFactories);
        const isInlineComponent =
          !isFactory && isPascalCase(name) && isInlineComponentInit(init);

        if (!isFactory && !isInlineComponent) return;

        const declaration = path.parentPath;
        if (!declaration.isVariableDeclaration()) return;

        // Skip if user already set displayName for this identifier in the parent scope.
        const parent = declaration.parentPath?.node;
        const siblings = (parent && parent.body) || [];
        const declIdx = siblings.indexOf(declaration.node);
        const alreadySet = siblings.slice(declIdx + 1).some((s) => {
          return (
            t.isExpressionStatement(s) &&
            t.isAssignmentExpression(s.expression) &&
            t.isMemberExpression(s.expression.left) &&
            t.isIdentifier(s.expression.left.object, { name }) &&
            t.isIdentifier(s.expression.left.property, { name: 'displayName' })
          );
        });
        if (alreadySet) return;

        declaration.insertAfter(makeDisplayNameAssignment(name));
      },

      FunctionDeclaration(path) {
        if (!t.isIdentifier(path.node.id)) return;
        const name = path.node.id.name;
        if (!/^[A-Z]/.test(name)) return; // uppercase-leading = component
        path.insertAfter(makeDisplayNameAssignment(name));
      },

      ClassDeclaration(path) {
        const node = path.node;
        if (!t.isIdentifier(node.id)) return;
        const name = node.id.name;
        if (!isPascalCase(name)) return;
        if (!extendsReactBaseClass(node.superClass)) return;
        if (hasStaticDisplayName(node)) return;

        const prop = t.classProperty(
          t.identifier('displayName'),
          t.stringLiteral(name)
        );
        prop.static = true;
        node.body.body.unshift(prop);
      },
    },
  };
};
