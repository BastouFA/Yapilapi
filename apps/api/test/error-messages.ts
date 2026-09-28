/**
 * Every English error message the API can send, read from the source the way a lint rule would.
 * test/error-translations.test.ts checks each one has a translation in every language table
 * (packages/shared/src/locales/errors/), so a new message without translations fails CI.
 *
 * What counts as a message:
 * - the message of `new AppError(status, code, message, { fields })`, and each value in `fields`;
 * - the same for any function that builds one from its arguments (badRequest, notFound, a module's
 *   own `tooMany`…): each call is read with its arguments, so `notFound('Post')` gives
 *   "Post doesn't exist or isn't visible to you.";
 * - `{ error: { code, message } }` objects sent directly;
 * - zod messages in schemas (`.min(1, 'Add a title.')`, `{ message }`, `addIssue`), in the API and
 *   in packages/shared, plus zod's own default messages (ZOD_DEFAULT_MESSAGES).
 *
 * A message built from values (`Wait ${n} seconds.`) becomes a template with `{name}` slots named
 * after the value (`Wait {n} seconds.`); a condition between two strings gives both messages.
 */
import { readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
const API_SRC = join(REPO, 'apps/api/src');
const SHARED_SRC = join(REPO, 'packages/shared/src');

/**
 * zod's default English messages (zod 3), as templates. parse() in src/lib/errors.ts sends them in
 * `fields` when a schema gives no message of its own.
 */
export const ZOD_DEFAULT_MESSAGES = [
  'Required',
  'Invalid input',
  'Invalid',
  'Invalid date',
  'Invalid email',
  'Invalid url',
  'Invalid uuid',
  'Invalid datetime',
  'Invalid time',
  'Invalid ip',
  'Invalid base64',
  'Expected {expected}, received {received}',
  "Invalid enum value. Expected {options}, received '{received}'",
  'Invalid literal value, expected {expected}',
  'Invalid discriminator value. Expected {options}',
  'Unrecognized key(s) in object: {keys}',
  'Invalid input: must start with "{prefix}"',
  'Invalid input: must end with "{suffix}"',
  'Invalid input: must include "{text}"',
  'String must contain at least {minimum} character(s)',
  'String must contain at most {maximum} character(s)',
  'String must contain exactly {length} character(s)',
  'Array must contain at least {minimum} element(s)',
  'Array must contain at most {maximum} element(s)',
  'Array must contain exactly {length} element(s)',
  'Number must be greater than or equal to {minimum}',
  'Number must be greater than {minimum}',
  'Number must be less than or equal to {maximum}',
  'Number must be less than {maximum}',
  'Number must be a multiple of {multipleOf}',
  'Number must be finite',
];

export interface Collected {
  /** Each message (a template when it has `{slots}`) and where it comes from. */
  messages: Map<string, string[]>;
  /** Message expressions that could not be read, as `file:line: source`. */
  unresolved: string[];
}

/** What a parameter holds at a call: its messages, or an object literal's properties. */
type Bound = string[] | null | { props: Map<string, string[] | null> };
type Env = Map<ts.Node, Bound>;

const MAX_VARIANTS = 64;
const GLOBALS = new Set(['Math', 'Number', 'String', 'JSON', 'Object', 'Array', 'Intl', 'Date', 'BigInt']);
/** zod checks whose message is the second argument (after the value) or the first. */
const ZOD_SECOND = new Set(['min', 'max', 'length', 'gt', 'gte', 'lt', 'lte', 'multipleOf', 'step', 'regex', 'startsWith', 'endsWith', 'includes', 'refine']);
const ZOD_FIRST = new Set([
  'email',
  'url',
  'uuid',
  'cuid',
  'cuid2',
  'ulid',
  'emoji',
  'base64',
  'datetime',
  'date',
  'time',
  'ip',
  'int',
  'positive',
  'negative',
  'nonnegative',
  'nonpositive',
  'finite',
  'safe',
  'nonempty',
]);
const ZOD_OPTION_KEYS = new Set(['message', 'required_error', 'invalid_type_error']);
/** zod calls whose object argument is a shape (field names), not options. */
const ZOD_SHAPES = new Set(['object', 'strictObject', 'looseObject', 'extend', 'merge', 'pick', 'omit', 'partial', 'required']);
/**
 * Errors the API catches and passes on with their message (`catch (e) { throw badRequest(e.message) }`):
 * their messages are collected where they are made, and `e.message` in a catch counts as read.
 */
export const RETHROWN_ERRORS: Record<string, number> = { SmsError: 1, BlockedUrlError: 0, VttError: 0 };

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)
    ? unwrap(e.expression)
    : e;

const isFunctionLike = (n: ts.Node): n is ts.SignatureDeclaration & { body?: ts.Node; parameters: ts.NodeArray<ts.ParameterDeclaration> } =>
  ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);

/** A string the translators should see: words, not an identifier or a code. */
const looksLikeMessage = (s: string) => /\s/.test(s) && /^[\p{Lu}"'‘“{]/u.test(s) && !/^[A-Z_]+$/.test(s);

export function collectErrorMessages(): Collected {
  const apiFiles = walkFiles(API_SRC);
  const program = ts.createProgram(apiFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    noLib: true,
  });
  const checker = program.getTypeChecker();
  const messages = new Map<string, string[]>();
  const unresolved: string[] = [];

  const where = (n: ts.Node) => {
    const sf = n.getSourceFile();
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
    return `${relative(REPO, realpathSync(sf.fileName))}:${line + 1}`;
  };
  const add = (msg: string, at: ts.Node) => {
    const list = messages.get(msg) ?? [];
    list.push(where(at));
    messages.set(msg, list);
  };

  /** The declaration an identifier points at, through imports. */
  const declOf = (id: ts.Node): ts.Declaration | undefined => {
    let sym = checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return sym?.declarations?.[0];
  };

  /** A function's body, whether declared as a function or as `const f = (…) => …`. */
  const functionOf = (callee: ts.Expression): (ts.SignatureDeclaration & { body?: ts.Node }) | undefined => {
    const d = declOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    if (!d) return undefined;
    if (isFunctionLike(d)) return d;
    if (ts.isVariableDeclaration(d) && d.initializer) {
      const init = unwrap(d.initializer);
      if (isFunctionLike(init)) return init;
    }
    return undefined;
  };

  /** A name for a value in a template: `{count}` for `${count}` or `${list.count}`. */
  const nameOf = (e: ts.Expression): string => {
    e = unwrap(e);
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    if (ts.isElementAccessExpression(e)) return nameOf(e.expression);
    if (ts.isBinaryExpression(e)) return nameOf(e.left);
    if (ts.isConditionalExpression(e)) return nameOf(e.whenTrue);
    if (ts.isPrefixUnaryExpression(e)) return nameOf(e.operand);
    if (ts.isCallExpression(e)) {
      const c = unwrap(e.expression);
      if (ts.isPropertyAccessExpression(c)) {
        const root = unwrap(c.expression);
        if (ts.isIdentifier(root) && GLOBALS.has(root.text)) return e.arguments[0] ? nameOf(e.arguments[0]) : c.name.text;
        return nameOf(root);
      }
      return e.arguments[0] ? nameOf(e.arguments[0]) : nameOf(c);
    }
    return 'value';
  };

  const product = (parts: string[][]): string[] => {
    let acc = [''];
    for (const p of parts) {
      const next: string[] = [];
      for (const a of acc) for (const b of p) next.push(a + b);
      acc = next.slice(0, MAX_VARIANTS);
    }
    return acc;
  };

  /** Strings in a constant table (`MESSAGES[kind]`, `ERRORS[code][1]`). */
  const tableStrings = (init: ts.Node): string[] => {
    const out: string[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && looksLikeMessage(n.text)) out.push(n.text);
      n.forEachChild(visit);
    };
    visit(init);
    return out;
  };

  const seen = new Set<ts.Node>();

  /** An argument as a parameter holds it: messages, or an object literal's properties. */
  const bind = (arg: ts.Expression, env: Env, depth: number): Bound => {
    const a = unwrap(arg);
    if (!ts.isObjectLiteralExpression(a)) return evaluate(a, env, depth);
    const props = new Map<string, string[] | null>();
    for (const p of a.properties) if (ts.isPropertyAssignment(p)) props.set(p.name.getText(), evaluate(p.initializer, env, depth));
    return { props };
  };

  /** A number known from the source: a literal, a numeric constant, or arithmetic on them. */
  const numberOf = (expr: ts.Expression, depth = 0): number | null => {
    const e = unwrap(expr);
    if (depth > 8) return null;
    if (ts.isNumericLiteral(e)) return Number(e.text.replace(/_/g, ''));
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      if (d && ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const) return numberOf(d.initializer, depth + 1);
      return null;
    }
    if (ts.isBinaryExpression(e)) {
      const a = numberOf(e.left, depth + 1);
      const b = numberOf(e.right, depth + 1);
      if (a === null || b === null) return null;
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.PlusToken:
          return a + b;
        case ts.SyntaxKind.MinusToken:
          return a - b;
        case ts.SyntaxKind.AsteriskToken:
          return a * b;
        case ts.SyntaxKind.SlashToken:
          return a / b;
      }
      return null;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText() === 'Math' && e.arguments.length === 1) {
      const v = numberOf(e.arguments[0]!, depth + 1);
      const f = e.expression.name.text;
      return v === null ? null : f === 'floor' ? Math.floor(v) : f === 'ceil' ? Math.ceil(v) : f === 'round' ? Math.round(v) : null;
    }
    return null;
  };

  /** `x` in `for (const x of ['a', 'b'])` or `for (const [x, y] of [['a', 1], …] as const)`: each value. */
  const loopValues = (d: ts.Declaration): string[] | null => {
    let index = -1;
    let decl: ts.Node = d;
    if (ts.isBindingElement(d) && ts.isArrayBindingPattern(d.parent)) {
      index = d.parent.elements.indexOf(d);
      decl = d.parent.parent;
    }
    if (!ts.isVariableDeclaration(decl) || !ts.isVariableDeclarationList(decl.parent) || !ts.isForOfStatement(decl.parent.parent)) return null;
    const list = unwrap(decl.parent.parent.expression);
    if (!ts.isArrayLiteralExpression(list)) return null;
    const out: string[] = [];
    for (const el of list.elements) {
      let v: ts.Expression | undefined = unwrap(el as ts.Expression);
      if (index >= 0) v = ts.isArrayLiteralExpression(v) ? v.elements[index] : undefined;
      v = v && unwrap(v);
      if (!v || !(ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))) return null;
      out.push(v.text);
    }
    return out.length ? out : null;
  };

  /**
   * The messages an expression can be, as templates; null when it can't be read. Parameters in
   * `env` stand for the caller's arguments; a parameter with no known value becomes a slot.
   */
  const evaluate = (expr: ts.Expression, env: Env, depth = 0): string[] | null => {
    if (depth > 12) return null;
    const e = unwrap(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
    const num = ts.isIdentifier(e) || ts.isBinaryExpression(e) || ts.isCallExpression(e) ? numberOf(e, depth) : null;
    if (num !== null && Number.isFinite(num)) return [String(num)];
    if (ts.isTemplateExpression(e)) {
      const parts: string[][] = [[e.head.text]];
      const names = new Map<string, number>();
      for (const span of e.templateSpans) {
        const v = evaluate(span.expression, env, depth + 1);
        if (v) parts.push(v);
        else {
          let name = nameOf(span.expression);
          const n = (names.get(name) ?? 0) + 1;
          names.set(name, n);
          if (n > 1) name = `${name}${n}`;
          parts.push([`{${name}}`]);
        }
        parts.push([span.literal.text]);
      }
      return product(parts);
    }
    if (ts.isConditionalExpression(e)) {
      const a = evaluate(e.whenTrue, env, depth + 1);
      const b = evaluate(e.whenFalse, env, depth + 1);
      return a || b ? [...(a ?? []), ...(b ?? [])] : null;
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) {
        const l = evaluate(e.left, env, depth + 1) ?? [`{${nameOf(e.left)}}`];
        const r = evaluate(e.right, env, depth + 1) ?? [`{${nameOf(e.right)}}`];
        return product([l, r]);
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const l = evaluate(e.left, env, depth + 1);
        const r = evaluate(e.right, env, depth + 1);
        return l || r ? [...(l ?? []), ...(r ?? [])] : null;
      }
      return null;
    }
    if (ts.isIdentifier(e)) {
      const d = declOf(e);
      if (!d) return null;
      if (ts.isParameter(d)) {
        const b = env.get(d);
        return Array.isArray(b) ? b : [`{${d.name.getText()}}`];
      }
      const looped = loopValues(d);
      if (looped) return looped;
      if (ts.isVariableDeclaration(d) && d.initializer && ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const && !seen.has(d)) {
        seen.add(d);
        try {
          const init = unwrap(d.initializer);
          if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) return null;
          return evaluate(init, env, depth + 1);
        } finally {
          seen.delete(d);
        }
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      let root: ts.Expression = e;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = unwrap(root.expression);
      if (!ts.isIdentifier(root)) return null;
      const d = declOf(root);
      if (d && ts.isVariableDeclaration(d) && d.initializer) {
        const init = unwrap(d.initializer);
        if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
          const strings = tableStrings(init);
          return strings.length ? strings : null;
        }
      }
      if (d && ts.isParameter(d)) {
        // `o.message` where the caller passed `{ message: '…' }`; a property it left out is no message.
        const b = env.get(d);
        if (b && !Array.isArray(b) && ts.isPropertyAccessExpression(e) && unwrap(e.expression) === root) {
          const name = e.name.text;
          return b.props.has(name) ? (b.props.get(name) ?? null) : [];
        }
        return [`{${nameOf(e)}}`];
      }
      return null;
    }
    if (ts.isCallExpression(e)) {
      const fn = functionOf(e.expression);
      if (!fn?.body || seen.has(fn)) return null;
      seen.add(fn);
      try {
        const inner: Env = new Map();
        fn.parameters.forEach((p, i) => {
          const arg = e.arguments[i];
          const given = arg ?? p.initializer;
          inner.set(p, given ? bind(given, env, depth + 1) : null);
        });
        const results: string[] = [];
        let any = false;
        const returns = (n: ts.Node) => {
          if (n !== fn.body && isFunctionLike(n)) return;
          if (ts.isReturnStatement(n) && n.expression) {
            const r = evaluate(n.expression, inner, depth + 1);
            if (r) {
              any = true;
              results.push(...r);
            }
          }
          n.forEachChild(returns);
        };
        if (ts.isBlock(fn.body)) returns(fn.body);
        else {
          const r = evaluate(fn.body as ts.Expression, inner, depth + 1);
          if (r) {
            any = true;
            results.push(...r);
          }
        }
        return any ? results : null;
      } finally {
        seen.delete(fn);
      }
    }
    return null;
  };

  // ── Where messages are made ─────────────────────────────────────────────
  /** A site's message expressions: the message and each `fields` value. */
  const siteExprs = (message: ts.Expression | undefined, details: ts.Expression | undefined): ts.Expression[] => {
    const out: ts.Expression[] = [];
    if (message) out.push(message);
    const d = details && unwrap(details);
    if (d && ts.isObjectLiteralExpression(d))
      for (const p of d.properties) {
        if (!ts.isPropertyAssignment(p) || p.name.getText() !== 'fields') continue;
        const f = unwrap(p.initializer);
        if (ts.isObjectLiteralExpression(f)) for (const fp of f.properties) if (ts.isPropertyAssignment(fp)) out.push(fp.initializer);
      }
    return out;
  };

  /** Parameters of enclosing functions that an expression reads. */
  const paramDeps = (expr: ts.Node): Set<ts.Node> => {
    const deps = new Set<ts.Node>();
    const visit = (n: ts.Node) => {
      if (ts.isIdentifier(n)) {
        const d = declOf(n);
        if (d && ts.isParameter(d)) deps.add(d);
      }
      n.forEachChild(visit);
    };
    visit(expr);
    return deps;
  };

  /** Functions that build an error from their arguments, with the message expressions inside them. */
  const sinks = new Map<ts.Node, ts.Expression[]>();
  interface Site {
    node: ts.Node;
    exprs: ts.Expression[];
    /** For a call to a sink: the sink and the call. */
    call?: ts.CallExpression;
  }
  const sites: Site[] = [];
  const zodSites: { node: ts.Node; expr: ts.Expression }[] = [];

  const apiSet = new Set(apiFiles.map((f) => realpathSync(f)));
  const sharedFiles = program.getSourceFiles().filter((sf) => {
    const p = realpathSync(sf.fileName);
    return p.startsWith(SHARED_SRC + '/') && !p.includes('/locales/') && !/\.test\.ts$/.test(p);
  });
  const usesZod = (sf: ts.SourceFile) => sf.statements.some((s) => ts.isImportDeclaration(s) && (s.moduleSpecifier as ts.StringLiteral).text === 'zod');

  for (const sf of [...program.getSourceFiles().filter((s) => apiSet.has(realpathSync(s.fileName))), ...sharedFiles]) {
    const zod = usesZod(sf);
    const isApi = apiSet.has(realpathSync(sf.fileName));
    const visit = (n: ts.Node) => {
      if (isApi && ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'AppError' && n.arguments)
        sites.push({ node: n, exprs: siteExprs(n.arguments[2], n.arguments[3]) });
      if (isApi && ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text in RETHROWN_ERRORS) {
        const m = n.arguments?.[RETHROWN_ERRORS[n.expression.text]!];
        if (m) sites.push({ node: n, exprs: [m] });
      }
      // `{ error: { code, message } }` sent as it is.
      if (isApi && ts.isPropertyAssignment(n) && n.name.getText() === 'error') {
        const o = unwrap(n.initializer);
        if (ts.isObjectLiteralExpression(o)) {
          const m = o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'message');
          // The error handler passes on Fastify's own errors (`message: e.message`); those stay as they are.
          const passedOn =
            ts.isPropertyAccessExpression(unwrap(m?.initializer ?? o)) && (unwrap(m!.initializer) as ts.PropertyAccessExpression).name.text === 'message';
          if (m && !passedOn && o.properties.some((p) => p.name?.getText() === 'code')) sites.push({ node: m, exprs: [m.initializer] });
        }
      }
      if (zod && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const idx = ZOD_SECOND.has(method) ? 1 : ZOD_FIRST.has(method) ? 0 : -1;
        const arg = idx >= 0 ? n.arguments[idx] : undefined;
        const a = arg && unwrap(arg);
        if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a) || ts.isTemplateExpression(a))) zodSites.push({ node: a, expr: a });
        // { message } on a check, { required_error } on a type, ctx.addIssue({ message }).
        for (const x of n.arguments) {
          const o = unwrap(x);
          if (!ts.isObjectLiteralExpression(o)) continue;
          if (idx < 0 && method !== 'addIssue' && !(ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'z')) continue;
          if (ZOD_SHAPES.has(method)) continue;
          for (const p of o.properties)
            if (ts.isPropertyAssignment(p) && ZOD_OPTION_KEYS.has(p.name.getText())) zodSites.push({ node: p, expr: p.initializer });
        }
      }
      // errorMap: () => ({ message: '…' })
      if (zod && ts.isPropertyAssignment(n) && n.name.getText() === 'errorMap') {
        const inner = (m: ts.Node) => {
          if (ts.isPropertyAssignment(m) && m.name.getText() === 'message') zodSites.push({ node: m, expr: m.initializer });
          m.forEachChild(inner);
        };
        inner(n.initializer);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }

  // A site that reads its function's parameters makes that function a sink: its callers give the
  // values. Calls to sinks are sites too, and can make their own function a sink (a fixpoint).
  const enclosingFunction = (n: ts.Node) => {
    for (let p = n.parent; p; p = p.parent) if (isFunctionLike(p)) return p;
    return undefined;
  };
  const sinkOf = (call: ts.CallExpression) => {
    const fn = functionOf(call.expression);
    return fn && sinks.has(fn) ? fn : undefined;
  };
  const exprsOfCall = (call: ts.CallExpression): ts.Expression[] => {
    const fn = sinkOf(call)!;
    return fn.parameters.map((p, i) => call.arguments[i] ?? p.initializer).filter((x): x is ts.Expression => !!x);
  };
  const markSinks = (list: Site[]) => {
    let changed = false;
    for (const s of list) {
      const exprs = s.call ? exprsOfCall(s.call) : s.exprs;
      const fnParams = new Set<ts.Node>();
      for (const x of exprs) for (const d of paramDeps(x)) fnParams.add(d.parent);
      for (const fn of fnParams) {
        if (!isFunctionLike(fn)) continue;
        const own = sinks.get(fn) ?? [];
        const add = s.call ? [s.call] : s.exprs;
        const fresh = add.filter((x) => !own.includes(x));
        if (fresh.length) {
          sinks.set(fn, [...own, ...fresh]);
          changed = true;
        }
      }
    }
    return changed;
  };
  const callSites = (): Site[] => {
    const out: Site[] = [];
    for (const sf of program.getSourceFiles()) {
      if (!apiSet.has(realpathSync(sf.fileName))) continue;
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && sinkOf(n)) out.push({ node: n, exprs: [], call: n });
        n.forEachChild(visit);
      };
      visit(sf);
    }
    return out;
  };
  markSinks(sites);
  let calls = callSites();
  for (let i = 0; i < 10 && markSinks(calls); i++) calls = callSites();

  /** A sink's messages for one call: its message expressions read with the call's arguments. */
  const evalSinkCall = (call: ts.CallExpression, env: Env, depth: number): string[] | null => {
    const fn = sinkOf(call)!;
    if (seen.has(fn) || depth > 8) return null;
    seen.add(fn);
    try {
      const inner: Env = new Map();
      fn.parameters.forEach((p, i) => {
        const arg = call.arguments[i] ?? p.initializer;
        inner.set(p, arg ? bind(arg, env, 0) : null);
      });
      const out: string[] = [];
      let read = false;
      for (const x of sinks.get(fn)!) {
        const r = ts.isCallExpression(x) && sinkOf(x) ? evalSinkCall(x, inner, depth + 1) : evaluate(x, inner);
        if (r) {
          read = true;
          out.push(...r);
        }
      }
      return read ? out : null;
    } finally {
      seen.delete(fn);
    }
  };

  const isSlotOnly = (m: string) => /^\{[^}]+\}$/.test(m);
  /** `e.message` where `e` is what a catch caught: one of RETHROWN_ERRORS. */
  const isCaughtMessage = (x: ts.Node) => {
    const e = ts.isExpression(x) ? unwrap(x) : x;
    if (!ts.isPropertyAccessExpression(e) || e.name.text !== 'message') return false;
    const root = unwrap(e.expression);
    const d = ts.isIdentifier(root) ? declOf(root) : undefined;
    return !!d && ts.isVariableDeclaration(d) && ts.isCatchClause(d.parent);
  };
  const record = (node: ts.Node, r: string[] | null, source: ts.Node) => {
    const good = (r ?? []).filter((m) => m && !isSlotOnly(m));
    // [] is a call that makes no message here (an option left out); null is one we couldn't read.
    if (r?.length === 0 || (!good.length && isCaughtMessage(source))) return;
    if (!good.length) unresolved.push(`${where(node)}: ${source.getText().slice(0, 120)}`);
    for (const m of good) add(m, node);
  };

  for (const s of [...sites, ...calls]) {
    const fn = enclosingFunction(s.node);
    // Read with the function's own parameters as slots when it is a sink and nobody calls it
    // with values; otherwise its callers cover it.
    const isSinkBody = fn && sinks.has(fn) && (s.call ? sinks.get(fn)!.includes(s.call) : s.exprs.some((x) => sinks.get(fn)!.includes(x)));
    if (isSinkBody) continue;
    if (s.call) {
      const r = evalSinkCall(s.call, new Map(), 0);
      const first = s.call.arguments[0];
      record(s.node, r, first && isCaughtMessage(first) ? first : s.call);
      // `{ fields: { … } }` handed to a builder (`badRequest('…', { fields: { password: 'Incorrect.' } })`).
      for (const arg of s.call.arguments) for (const x of siteExprs(undefined, arg)) record(s.node, evaluate(x, new Map()), x);
      continue;
    }
    for (const x of s.exprs) record(s.node, evaluate(x, new Map()), x);
  }
  // A builder nobody calls directly (passed around as a value): its messages with slots.
  for (const [fn, exprs] of sinks) {
    if (calls.some((c) => sinkOf(c.call!) === fn)) continue;
    for (const x of exprs) {
      const r = ts.isCallExpression(x) && sinkOf(x) ? evalSinkCall(x, new Map(), 0) : evaluate(x, new Map());
      for (const m of r ?? []) if (!isSlotOnly(m)) add(m, x);
    }
  }
  for (const z of zodSites) record(z.node, evaluate(z.expr, new Map()), z.expr);
  for (const m of ZOD_DEFAULT_MESSAGES) messages.set(m, [...(messages.get(m) ?? []), 'zod (default message)']);

  return { messages, unresolved };
}
