const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Inspect compiler-emitted children: JSX indentation disappears, but the
// same-line space that broke Audit/Reports survives as a string. Fragments
// and conditional branches inherit their native parent's text constraint.
function invalidChildren(source) {
  const input = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const containers = new Set();
  for (const statement of input.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'react-native') continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      const original = (binding.propertyName ?? binding.name).text;
      if (['View', 'ScrollView', 'Pressable', 'SafeAreaView', 'KeyboardAvoidingView'].includes(original) || original.startsWith('Touchable')) containers.add(binding.name.text);
    }
  }
  const emitted = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const tree = ts.createSourceFile('screen.js', emitted, ts.ScriptTarget.Latest, true);
  const problems = [];
  const jsx = node => ts.isCallExpression(node) && /^_jsx(?:s)?$/.test(node.expression.getText(tree));
  const children = node => {
    const props = node.arguments[1];
    return props && ts.isObjectLiteralExpression(props)
      ? props.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'children')?.initializer : undefined;
  };
  function inspect(node) {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (ts.isNumericLiteral(node) || node.text.length) problems.push(node.getText(tree));
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(inspect);
    else if (ts.isParenthesizedExpression(node)) inspect(node.expression);
    else if (ts.isConditionalExpression(node)) { inspect(node.whenTrue); inspect(node.whenFalse); }
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      // Zero is rendered; a truthy guard and empty strings are not.
      if (ts.isNumericLiteral(node.left) && Number(node.left.text) === 0) inspect(node.left);
      inspect(node.right);
    } else if (jsx(node) && node.arguments[0].getText(tree) === '_Fragment') inspect(children(node));
  }
  function visit(node) {
    if (jsx(node) && containers.has(node.arguments[0]?.getText(tree))) inspect(children(node));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return problems;
}

test('native JSX guard catches the Audit/Reports pagination whitespace regression', () => {
  assert.deepEqual(invalidChildren(`import { View } from 'react-native'; const screen = <View>{first && <Button />} {next && <Button />}</View>;`), ['" "']);
});
test('native JSX guard catches raw text through fragments, aliases and conditional branches', () => {
  assert.equal(invalidChildren(`import { Pressable as P, ScrollView, TouchableOpacity } from 'react-native'; const screen = <ScrollView><P>{ok ? <>Bad</> : null}</P><TouchableOpacity>{' '}</TouchableOpacity></ScrollView>;`).length, 2);
});
test('native JSX guard permits indentation and legitimate Text children', () => {
  assert.deepEqual(invalidChildren(`import { View, Text } from 'react-native'; const screen = <View>
    {first && <Text>First </Text>}
    {next && <Text>{' '}Next</Text>}
  </View>;`), []);
  assert.deepEqual(invalidChildren(`import { View } from 'react-native'; const screen = <View>{1 && <Button />}{''}</View>;`), []);
  assert.deepEqual(invalidChildren(`import { View } from 'react-native'; const screen = <View>{0 && <Button />}</View>;`), ['0']);
});
test('all M06 screens and shared native components have no literal children outside Text', () => {
  const root = path.resolve(__dirname, '../apps/zude-mobile/src');
  const directories = ['features/team', 'features/working', 'features/timesheets', 'features/management', 'components', 'navigation', 'features/identity', 'features/time'];
  for (const directory of directories) for (const file of fs.readdirSync(path.join(root, directory)).filter(file => file.endsWith('.tsx'))) {
    assert.deepEqual(invalidChildren(fs.readFileSync(path.join(root, directory, file), 'utf8')), [], `${directory}/${file}`);
  }
});
