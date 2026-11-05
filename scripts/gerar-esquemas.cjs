// Builds esquemas.json, the input schema of every tool, for 9router models.
// The engine gives a running mod no schemas, but it writes them as TypeScript
// into a hot-reloaded mod's .claude-plugin/types folder.
//
// node gerar-esquemas.cjs <types folder> <output file>
// (needs `typescript` reachable, through NODE_PATH if not installed here)
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const [typesDir, output] = process.argv.slice(2)
if (!typesDir || !output) {
  throw new Error('uso: node gerar-esquemas.cjs <pasta types> <arquivo de saida>')
}

const docOf = node => {
  const docs = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
  const text = docs.map(doc => ts.getTextOfJSDocComment(doc.comment) ?? '').join('\n').trim()

  return text || undefined
}

const nameOf = member => {
  const { name } = member

  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : name.getText()
}

function objectOf(members) {
  const schema = { type: 'object', properties: {} }
  const required = []
  for (const member of members) {
    if (ts.isIndexSignatureDeclaration(member)) {
      schema.additionalProperties = toSchema(member.type)
    } else if (ts.isPropertySignature(member) && member.type) {
      const key = nameOf(member)
      const description = docOf(member)
      schema.properties[key] = { ...toSchema(member.type), ...(description ? { description } : {}) }
      if (!member.questionToken) {
        required.push(key)
      }
    }
  }
  if (required.length > 0) {
    schema.required = required
  }

  return schema
}

function toSchema(node) {
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword:
      return { type: 'string' }
    case ts.SyntaxKind.NumberKeyword:
      return { type: 'number' }
    case ts.SyntaxKind.BooleanKeyword:
      return { type: 'boolean' }
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.AnyKeyword:
      return {}
    default:
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return toSchema(node.type)
  }
  if (ts.isTypeLiteralNode(node)) {
    return objectOf(node.members)
  }
  if (ts.isArrayTypeNode(node)) {
    return { type: 'array', items: toSchema(node.elementType) }
  }
  if (ts.isTupleTypeNode(node)) {
    return { type: 'array', items: {}, minItems: node.elements.length, maxItems: node.elements.length }
  }
  if (ts.isLiteralTypeNode(node)) {
    const { literal } = node
    if (literal.kind === ts.SyntaxKind.NullKeyword) {
      return { type: 'null' }
    }
    if (literal.kind === ts.SyntaxKind.TrueKeyword || literal.kind === ts.SyntaxKind.FalseKeyword) {
      return { type: 'boolean', const: literal.kind === ts.SyntaxKind.TrueKeyword }
    }
    if (ts.isNumericLiteral(literal)) {
      return { type: 'number', const: Number(literal.text) }
    }
    if (ts.isPrefixUnaryExpression(literal)) {
      return { type: 'number', const: Number(literal.getText()) }
    }

    return { type: 'string', const: literal.text }
  }
  if (ts.isUnionTypeNode(node)) {
    const parts = node.types.map(toSchema)
    if (parts.every(part => part.type === 'string' && 'const' in part)) {
      return { type: 'string', enum: parts.map(part => part.const) }
    }
    if (parts.every(part => part.type === 'number' && 'const' in part)) {
      return { type: 'number', enum: parts.map(part => part.const) }
    }

    return { anyOf: parts }
  }
  if (ts.isIntersectionTypeNode(node)) {
    return { allOf: node.types.map(toSchema) }
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText()
    const [first, second] = node.typeArguments ?? []
    if ((name === 'Array' || name === 'ReadonlyArray') && first) {
      return { type: 'array', items: toSchema(first) }
    }
    if (name === 'Record' && second) {
      return { type: 'object', additionalProperties: toSchema(second) }
    }
  }
  if (ts.isTypeOperatorNode(node)) {
    return toSchema(node.type)
  }

  // A shape this generator does not know is left open rather than wrong.
  return {}
}

const out = {}
const unknownInterfaces = new Set(['BuiltinToolInputs', 'McpToolInputs'])
for (const file of ['claude-code-tools', 'claude-code-mcp']) {
  const full = path.join(typesDir, file, 'index.d.ts')
  const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = node => {
    if (ts.isInterfaceDeclaration(node) && unknownInterfaces.has(node.name.text)) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.type) {
          out[nameOf(member)] = {
            description: docOf(member) ?? '',
            input_schema: toSchema(member.type),
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

fs.writeFileSync(output, JSON.stringify(out))
console.log(`${Object.keys(out).length} ferramentas, ${fs.statSync(output).size} bytes`)
