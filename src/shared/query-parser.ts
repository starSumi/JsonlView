import {
  createQueryAstV1,
  QUERY_AST_LIMITS,
  type QueryAstV1,
} from './query-ast';
import type {
  FieldPath,
  JsonKind,
  JsonScalar,
  Predicate,
} from './types';

/** Limits are deliberately stricter than the transport limits. */
export const QUERY_DSL_LIMITS: Readonly<{
  maxSourceLength: number;
  maxTokens: number;
  maxDepth: number;
  maxNodes: number;
  maxPathTokens: number;
  maxPathKeyLength: number;
  maxDiagnosticFoundLength: number;
}> = Object.freeze({
  maxSourceLength: QUERY_AST_LIMITS.maxStringLength,
  maxTokens: 512,
  maxDepth: QUERY_AST_LIMITS.maxDepth,
  maxNodes: QUERY_AST_LIMITS.maxNodes,
  maxPathTokens: QUERY_AST_LIMITS.maxPathTokens,
  maxPathKeyLength: QUERY_AST_LIMITS.maxPathKeyLength,
  maxDiagnosticFoundLength: 32,
});

export type QueryDiagnosticCode =
  | 'source_too_large'
  | 'empty_expression'
  | 'unexpected_character'
  | 'unterminated_string'
  | 'invalid_string'
  | 'too_many_tokens'
  | 'unexpected_token'
  | 'missing_operand'
  | 'missing_operator'
  | 'missing_closing_parenthesis'
  | 'unsupported_operator'
  | 'invalid_literal'
  | 'invalid_path'
  | 'invalid_kind'
  | 'invalid_profile_field'
  | 'ambiguous_expression'
  | 'depth_limit_exceeded'
  | 'node_limit_exceeded'
  | 'path_limit_exceeded';

export interface QueryDiagnostic {
  readonly code: QueryDiagnosticCode;
  readonly severity: 'error';
  readonly message: string;
  readonly start: number;
  readonly length: number;
  readonly expected?: readonly string[];
  readonly found?: string;
}

export interface QueryParseSuccess {
  readonly ok: true;
  readonly ast: QueryAstV1;
  readonly predicate: Predicate | undefined;
  readonly diagnostics: readonly [];
}

export interface QueryParseFailure {
  readonly ok: false;
  readonly ast?: undefined;
  readonly predicate?: undefined;
  readonly diagnostics: readonly QueryDiagnostic[];
}

export type QueryParseResult = QueryParseSuccess | QueryParseFailure;

type TokenKind = 'identifier' | 'number' | 'string' | 'operator' | 'open' | 'close' | 'dot' | 'bracket-open'
  | 'bracket-close' | 'comma' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly value?: JsonScalar;
}

interface LexResult {
  readonly tokens: readonly Token[];
  readonly diagnostics: readonly QueryDiagnostic[];
}

const JSON_KINDS: readonly JsonKind[] = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
const COMPARISON_OPERATORS = new Set(['=', '==', '!=', '<', '<=', '>', '>=']);
const TEXT_OPERATORS = new Set(['contains', 'starts_with', 'ends_with']);
const PRESENCE_OPERATORS = new Set(['exists', 'is_null']);

/** Parse the bounded query DSL and lower it to the versioned Predicate AST. */
export function parseQueryDsl(source: string): QueryParseResult {
  if (typeof source !== 'string') {
    return failure(diagnostic('invalid_literal', 'Query must be text.', 0, 0));
  }
  if (source.length > QUERY_DSL_LIMITS.maxSourceLength) {
    return failure(diagnostic('source_too_large', `Query exceeds ${QUERY_DSL_LIMITS.maxSourceLength} characters.`,
      QUERY_DSL_LIMITS.maxSourceLength, source.length - QUERY_DSL_LIMITS.maxSourceLength));
  }
  const lexed = lex(source);
  if (lexed.diagnostics.length > 0) return failure(...lexed.diagnostics);
  const first = lexed.tokens[0];
  if (first === undefined || first.kind === 'eof') {
    return success(undefined);
  }
  const parser = new Parser(lexed.tokens);
  const predicate = parser.parse();
  if (parser.diagnostics.length > 0 || predicate === undefined) {
    return failure(...parser.diagnostics.length > 0
      ? parser.diagnostics
      : [diagnostic('empty_expression', 'Expected a query expression.', 0, source.length)]);
  }
  const ast = createQueryAstV1(predicate);
  return { ok: true, ast, predicate, diagnostics: [] };
}

/** Alias kept for callers that describe this operation as compilation. */
export const compileQueryDsl: typeof parseQueryDsl = parseQueryDsl;
export const parseQuery: typeof parseQueryDsl = parseQueryDsl;

function success(predicate: Predicate | undefined): QueryParseSuccess {
  return {
    ok: true,
    ast: createQueryAstV1(predicate),
    predicate,
    diagnostics: [],
  };
}

function failure(...diagnostics: QueryDiagnostic[]): QueryParseFailure {
  return { ok: false, diagnostics };
}

function diagnostic(
  code: QueryDiagnosticCode,
  message: string,
  start: number,
  length: number,
  options: { expected?: readonly string[]; found?: string } = {},
): QueryDiagnostic {
  const found = options.found === undefined
    ? undefined
    : options.found.slice(0, QUERY_DSL_LIMITS.maxDiagnosticFoundLength);
  return {
    code,
    severity: 'error',
    message,
    start: Math.max(0, start),
    length: Math.min(QUERY_DSL_LIMITS.maxSourceLength, Math.max(0, length)),
    ...(options.expected === undefined ? {} : { expected: options.expected }),
    ...(found === undefined ? {} : { found }),
  };
}

function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: QueryDiagnostic[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const start = index;
    if (char === '(') {
      tokens.push({ kind: 'open', text: char, start, end: ++index });
      continue;
    }
    if (char === ')') {
      tokens.push({ kind: 'close', text: char, start, end: ++index });
      continue;
    }
    if (char === '.') {
      tokens.push({ kind: 'dot', text: char, start, end: ++index });
      continue;
    }
    if (char === '[') {
      tokens.push({ kind: 'bracket-open', text: char, start, end: ++index });
      continue;
    }
    if (char === ']') {
      tokens.push({ kind: 'bracket-close', text: char, start, end: ++index });
      continue;
    }
    if (char === ',') {
      tokens.push({ kind: 'comma', text: char, start, end: ++index });
      continue;
    }
    if (char === '"') {
      const end = scanString(source, index);
      if (end === undefined) {
        diagnostics.push(diagnostic('unterminated_string', 'String literal is not closed.', start, source.length - start));
        break;
      }
      const text = source.slice(start, end);
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== 'string') throw new Error('not string');
        tokens.push({ kind: 'string', text, start, end, value });
      } catch {
        diagnostics.push(diagnostic('invalid_string', 'String literal is not valid JSON string syntax.', start, end - start));
      }
      index = end;
      continue;
    }
    const operator = source.slice(index).match(/^(?:==|!=|<=|>=|=|<|>)/)?.[0];
    if (operator !== undefined) {
      index += operator.length;
      tokens.push({ kind: 'operator', text: operator, start, end: index });
      continue;
    }
    const number = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
    if (number !== undefined) {
      index += number.length;
      const value = Number(number);
      if (!Number.isFinite(value)) {
        diagnostics.push(diagnostic('invalid_literal', 'Numeric literal must be finite.', start, number.length));
      } else {
        tokens.push({ kind: 'number', text: number, start, end: index, value });
      }
      continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$@][A-Za-z0-9_$@-]*/)?.[0];
    if (identifier !== undefined) {
      index += identifier.length;
      tokens.push({ kind: 'identifier', text: identifier, start, end: index });
      continue;
    }
    diagnostics.push(diagnostic('unexpected_character', 'Character is not valid in the query DSL.', start, 1,
      { found: char }));
    index += 1;
  }
  if (tokens.length > QUERY_DSL_LIMITS.maxTokens) {
    diagnostics.push(diagnostic('too_many_tokens', `Query exceeds ${QUERY_DSL_LIMITS.maxTokens} tokens.`,
      source.length, 0));
    return { tokens: [], diagnostics };
  }
  tokens.push({ kind: 'eof', text: '', start: source.length, end: source.length });
  return { tokens, diagnostics };
}

function scanString(source: string, start: number): number | undefined {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return index + 1;
  }
  return undefined;
}

class Parser {
  readonly diagnostics: QueryDiagnostic[] = [];
  #index = 0;
  #depth = 0;
  #nodes = 0;
  private readonly tokens: readonly Token[];

  public constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  public parse(): Predicate | undefined {
    const predicate = this.parseOr();
    const next = this.peek();
    if (predicate !== undefined && next.kind !== 'eof' && next.kind !== 'close') {
      this.error('ambiguous_expression', 'Expected an explicit `and` or `or` between expressions.', next,
        ['and', 'or', ')']);
    }
    if (next.kind === 'close') {
      this.error('unexpected_token', 'Closing parenthesis has no matching opening parenthesis.', next, ['end of query']);
    }
    return predicate;
  }

  private parseOr(): Predicate | undefined {
    let left = this.parseAnd();
    while (this.isWord(this.peek(), 'or')) {
      this.advance();
      const right = this.parseAnd();
      if (left === undefined || right === undefined) continue;
      left = this.branch('or', left, right);
    }
    return left;
  }

  private parseAnd(): Predicate | undefined {
    let left = this.parseUnary();
    while (this.isWord(this.peek(), 'and')) {
      this.advance();
      const right = this.parseUnary();
      if (left === undefined || right === undefined) continue;
      left = this.branch('and', left, right);
    }
    return left;
  }

  private parseUnary(): Predicate | undefined {
    if (this.isWord(this.peek(), 'not')) {
      const token = this.advance();
      this.#depth += 1;
      if (this.#depth > QUERY_DSL_LIMITS.maxDepth) {
        this.error('depth_limit_exceeded', `Query exceeds depth ${QUERY_DSL_LIMITS.maxDepth}.`, token, ['shallower expression']);
        this.#depth -= 1;
        return undefined;
      }
      const argument = this.parseUnary();
      this.#depth -= 1;
      return argument === undefined ? undefined : this.node({ op: 'not', arg: argument }, token);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Predicate | undefined {
    const token = this.peek();
    if (token.kind === 'open') {
      this.advance();
      this.#depth += 1;
      if (this.#depth > QUERY_DSL_LIMITS.maxDepth) {
        this.error('depth_limit_exceeded', `Query exceeds depth ${QUERY_DSL_LIMITS.maxDepth}.`, token, ['shallower expression']);
        this.#depth -= 1;
        return undefined;
      }
      const expression = this.parseOr();
      this.#depth -= 1;
      if (this.peek().kind !== 'close') {
        this.error('missing_closing_parenthesis', 'Expected `)` to close this expression.', this.peek(), [')']);
      } else {
        this.advance();
      }
      return expression;
    }
    if (token.kind === 'close' || token.kind === 'eof') {
      this.error('missing_operand', 'Expected a query expression.', token, ['field', 'text(...)', '(']);
      return undefined;
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Predicate | undefined {
    const first = this.peek();
    if (first.kind === 'string') {
      this.advance();
      if (!isBoundedText(first.value)) {
        this.error('invalid_literal', 'Text literals must be non-empty and bounded.', first);
        return undefined;
      }
      return this.node({ op: 'text_search', value: String(first.value), caseSensitive: false }, first);
    }
    if (first.kind === 'identifier' && this.isWord(first, 'text') && this.tokens[this.#index + 1]?.kind === 'open') {
      return this.parseTextFunction();
    }
    const reference = this.parseReference();
    if (reference === undefined) return undefined;
    const operatorToken = this.peek();
    const operator = this.operator(operatorToken);
    if (operator === undefined) {
      this.error('missing_operator', 'Field references require an explicit operator.', operatorToken,
        ['==', 'contains', 'exists']);
      return undefined;
    }
    this.advance();
    if (reference.kind === 'profile') return this.parseProfilePredicate(reference.field, operator, operatorToken);
    if (PRESENCE_OPERATORS.has(operator)) {
      return this.node({ op: operator as 'exists' | 'is_null', path: reference.path }, operatorToken);
    }
    if (operator === 'kind_is') {
      const valueToken = this.peek();
      const literal = this.parseLiteral();
      if (typeof literal !== 'string' || !JSON_KINDS.includes(literal as JsonKind)) {
        this.error('invalid_kind', 'kind_is expects a JSON kind name.', valueToken, JSON_KINDS);
        return undefined;
      }
      return this.node({ op: 'kind_is', path: reference.path, kind: literal as JsonKind }, operatorToken);
    }
    const valueToken = this.peek();
    const literal = this.parseLiteral();
    if (literal === undefined) {
      this.error('invalid_literal', 'Expected a scalar literal after the operator.', valueToken,
        ['string', 'number', 'true', 'false', 'null']);
      return undefined;
    }
    if (TEXT_OPERATORS.has(operator)) {
      if (!isBoundedText(literal)) {
        this.error('invalid_literal', `${operator} expects a string literal.`, valueToken, ['string']);
        return undefined;
      }
      return this.node({ op: operator as 'contains' | 'starts_with' | 'ends_with', path: reference.path,
        value: literal, caseSensitive: false }, operatorToken);
    }
    if (!COMPARISON_OPERATORS.has(operator)) {
      this.error('unsupported_operator', 'Operator is not supported by the portable Predicate evaluator.', operatorToken);
      return undefined;
    }
    return this.node({ op: 'compare', path: reference.path, cmp: comparisonOperator(operator), value: literal }, operatorToken);
  }

  private parseTextFunction(): Predicate | undefined {
    const functionToken = this.advance();
    this.advance();
    const valueToken = this.peek();
    const literal = this.parseLiteral();
    if (!isBoundedText(literal)) {
      this.error('invalid_literal', 'text(...) expects one string literal.', valueToken, ['string']);
    }
    if (this.peek().kind === 'comma') {
      this.error('ambiguous_expression', 'text(...) accepts one argument.', this.advance(), [')']);
      while (this.peek().kind !== 'close' && this.peek().kind !== 'eof') this.advance();
    }
    if (this.peek().kind !== 'close') {
      this.error('missing_closing_parenthesis', 'Expected `)` after text(...).', this.peek(), [')']);
    } else {
      this.advance();
    }
    return isBoundedText(literal)
      ? this.node({ op: 'text_search', value: literal, caseSensitive: false }, functionToken)
      : undefined;
  }

  private parseProfilePredicate(field: string, operator: string, operatorToken: Token): Predicate | undefined {
    if (field.length === 0 || field.length > QUERY_AST_LIMITS.maxProfileFieldLength) {
      this.error('invalid_profile_field', 'Profile field name is outside the bounded limit.', operatorToken);
      return undefined;
    }
    if (operator === 'exists' || operator === 'is_null') {
      return this.node({ op: operator === 'exists' ? 'profile_exists' : 'profile_is_null', field }, operatorToken);
    }
    const valueToken = this.peek();
    const literal = this.parseLiteral();
    if (literal === undefined) {
      this.error('invalid_literal', 'Expected a scalar literal after the operator.', valueToken);
      return undefined;
    }
    if (TEXT_OPERATORS.has(operator)) {
      if (!isBoundedText(literal)) {
        this.error('invalid_literal', `${operator} expects a string literal.`, valueToken, ['string']);
        return undefined;
      }
      return this.node({ op: 'profile_text', field, cmp: operator as 'contains' | 'starts_with' | 'ends_with',
        value: literal, caseSensitive: false }, operatorToken);
    }
    if (!COMPARISON_OPERATORS.has(operator)) {
      this.error('unsupported_operator', 'Operator is not supported for profile fields.', operatorToken);
      return undefined;
    }
    return this.node({ op: 'profile_field', field, cmp: comparisonOperator(operator), value: literal }, operatorToken);
  }

  private parseReference(): { kind: 'record'; path: FieldPath; display: string } | { kind: 'profile'; field: string } | undefined {
    const first = this.peek();
    if (first.kind !== 'identifier') {
      this.error('invalid_path', 'Expected a field path.', first, ['field']);
      return undefined;
    }
    this.advance();
    if (first.text.startsWith('@')) {
      return { kind: 'profile', field: first.text.slice(1) };
    }
    const tokens: FieldPath['tokens'] = [];
    if (first.text !== '$') {
      tokens.push({ kind: 'key', value: first.text });
    }
    while (true) {
      if (this.peek().kind === 'dot') {
        this.advance();
        const key = this.peek();
        if (key.kind !== 'identifier' || key.text === '$' || key.text.startsWith('@')) {
          this.error('invalid_path', 'Expected a field name after `.`.', key, ['field']);
          return undefined;
        }
        this.advance();
        tokens.push({ kind: 'key', value: key.text });
        continue;
      }
      if (this.peek().kind === 'bracket-open') {
        this.advance();
        const value = this.peek();
        if (value.kind !== 'number' && value.kind !== 'string') {
          this.error('invalid_path', 'Expected an array index or quoted object key in brackets.', value, ['number', 'string']);
          return undefined;
        }
        this.advance();
        if (this.peek().kind !== 'bracket-close') {
          this.error('invalid_path', 'Expected `]` after bracket path segment.', this.peek(), [']']);
          return undefined;
        }
        this.advance();
        if (value.kind === 'number' && typeof value.value === 'number' && Number.isSafeInteger(value.value) && value.value >= 0) {
          tokens.push({ kind: 'index', value: value.value });
        } else if (value.kind === 'string' && typeof value.value === 'string') {
          tokens.push({ kind: 'key', value: value.value });
        } else {
          this.error('invalid_path', 'Bracket path segment is outside the bounded path contract.', value);
          return undefined;
        }
        continue;
      }
      break;
    }
    if ((tokens.length === 0 && first.text !== '$') || tokens.length > QUERY_DSL_LIMITS.maxPathTokens
      || tokens.some((token) => token.kind === 'key' && String(token.value).length > QUERY_DSL_LIMITS.maxPathKeyLength)) {
      this.error(tokens.length > QUERY_DSL_LIMITS.maxPathTokens ? 'path_limit_exceeded' : 'invalid_path',
        'Field path exceeds the bounded path contract.', first);
      return undefined;
    }
    return { kind: 'record', path: { tokens }, display: first.text === '$'
      ? `$${tokens.map((token) => token.kind === 'index' ? `[${String(token.value)}]` : `.${String(token.value)}`).join('')}`
      : tokens.map((token) => token.kind === 'index' ? `[${String(token.value)}]` : String(token.value)).join('.') };
  }

  private parseLiteral(): JsonScalar | undefined {
    const token = this.peek();
    if (token.kind === 'string' || token.kind === 'number') {
      this.advance();
      return token.value;
    }
    if (token.kind !== 'identifier') return undefined;
    this.advance();
    switch (token.text.toLocaleLowerCase()) {
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      default: return token.text;
    }
  }

  private operator(token: Token): string | undefined {
    if (token.kind === 'operator') return token.text;
    if (token.kind === 'identifier') {
      const value = token.text.toLocaleLowerCase();
      if (TEXT_OPERATORS.has(value) || PRESENCE_OPERATORS.has(value) || value === 'kind_is') return value;
    }
    return undefined;
  }

  private branch(op: 'and' | 'or', left: Predicate, right: Predicate): Predicate {
    return this.node({ op, args: [left, right] }, this.previous());
  }

  private node(predicate: Predicate, token: Token): Predicate {
    this.#nodes += 1;
    if (this.#nodes > QUERY_DSL_LIMITS.maxNodes) {
      this.error('node_limit_exceeded', `Query exceeds ${QUERY_DSL_LIMITS.maxNodes} expression nodes.`, token,
        ['smaller expression']);
    }
    return predicate;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.#index - 1)] ?? this.tokens[0]!;
  }

  private peek(): Token {
    return this.tokens[this.#index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private advance(): Token {
    const token = this.peek();
    this.#index += 1;
    return token;
  }

  private isWord(token: Token, word: string): boolean {
    return token.kind === 'identifier' && token.text.toLocaleLowerCase() === word;
  }

  private error(code: QueryDiagnosticCode, message: string, token: Token, expected?: readonly string[]): void {
    this.diagnostics.push(diagnostic(code, message, token.start, Math.max(1, token.end - token.start), {
      ...(expected === undefined ? {} : { expected }),
      ...(token.text === '' ? {} : { found: token.text }),
    }));
  }
}

function comparisonOperator(value: string): 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' {
  switch (value) {
    case '=':
    case '==': return 'eq';
    case '!=': return 'ne';
    case '<': return 'lt';
    case '<=': return 'lte';
    case '>': return 'gt';
    case '>=': return 'gte';
    default: return 'eq';
  }
}

function isBoundedText(value: JsonScalar | undefined): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= QUERY_AST_LIMITS.maxStringLength;
}
