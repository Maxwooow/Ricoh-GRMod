// A strict simulator for the subset of Tera Term Language that the camera's
// start-up script interpreter is known to support. Anything outside the subset
// is reported as an error, so tests catch scripts that stray from it.
//
// Supported:
//   ; comment lines            :label            goto label          exit
//   name = 123 | -1 | 'text'   (integer or string literal assignment)
//   if A op B then ... endif   (op: = <> < >, integer operands, may be nested;
//                               no else / elseif, no single-line if)
//   filesearch P               result = 1 if P exists, else 0
//   filestat P var             var = size of P; unchanged if P is missing
//   fileopen fh P 0            open for reading; fh < 0 on failure
//   fileread fh n strvar       read up to n bytes
//   str2code intvar S          character code of the first character; for an empty
//                              string 0, or (option) the variable is left unchanged
//   fileclose fh
//   filecreate fh P            create / truncate; fh < 0 on failure
//   filewrite fh S             append the string's bytes
//   filecopy P Q               copy P over Q (no effect if P is missing)
//   strcompare S T             result = 0 if equal, else -1 / 1
// P, Q, S, T are 'single-quoted' literals or string variables. Paths are
// compared case-insensitively. Strings behave like C strings: a 0x00 byte read
// from a file ends the string, so reading a zero byte gives an empty string and
// `str2code` returns 0 for it.

export interface SimFs {
  /** Files by full path, e.g. `C:\GBR1.JPG`, `A:\Resource\Jpeg\GoodBye.jpg`. */
  files: Map<string, Uint8Array>;
  /** Return true to make this `filecopy` fail (the destination is left unchanged). */
  failCopy?: (src: string, dst: string) => boolean;
  /** Return true to make this `filecreate` fail (the file is left unchanged). */
  failCreate?: (path: string) => boolean;
}

export interface SimResult {
  /** Number of statements executed. */
  steps: number;
  /** True when the script ended through `exit`. */
  exited: boolean;
  /** Set when the script is outside the supported subset, misuses a command or ran too long. */
  error?: string;
  /** The file commands that were executed, in order, with resolved operands and outcome. */
  trace: string[];
}

type Operand = { kind: 'int'; value: number } | { kind: 'str'; value: string } | { kind: 'var'; name: string };
/** A lexical token: a literal, or a word (identifier, keyword or operator; lower-cased). */
type Token = Operand | { word: string };

interface Statement {
  line: number;
  op: string;
  args: Operand[];
  /** `if`: comparison operator. */
  cmp?: string;
  /** `if`: index of the matching `endif`; `goto`: index of the target statement. */
  jump?: number;
}

const COMMAND_ARITY: Record<string, number> = {
  filesearch: 1,
  filestat: 2,
  fileopen: 3,
  fileread: 3,
  str2code: 2,
  fileclose: 1,
  filecreate: 2,
  filewrite: 2,
  filecopy: 2,
  strcompare: 2,
};

const KEYWORDS = new Set(['if', 'then', 'endif', 'goto', 'exit', ...Object.keys(COMMAND_ARITY)]);

/** Words that are reserved by Tera Term Language and must not be used as variable names. */
const RESERVED = new Set([
  ...KEYWORDS,
  'next',
  'else',
  'elseif',
  'for',
  'while',
  'endwhile',
  'do',
  'loop',
  'until',
  'enduntil',
  'break',
  'continue',
  'call',
  'return',
  'end',
  'include',
  'and',
  'or',
  'xor',
  'not',
]);

class ScriptError extends Error {}

function tokenize(text: string, line: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new ScriptError(`line ${line}: unterminated string`);
      out.push({ kind: 'str', value: text.slice(i + 1, end) });
      i = end + 1;
    } else if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(text[i + 1] ?? ''))) {
      const m = /^-?[0-9]+/.exec(text.slice(i)) as RegExpExecArray;
      out.push({ kind: 'int', value: parseInt(m[0], 10) });
      i += m[0].length;
      if (/[A-Za-z_]/.test(text[i] ?? '')) throw new ScriptError(`line ${line}: malformed number`);
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i)) as RegExpExecArray;
      out.push({ word: m[0].toLowerCase() });
      i += m[0].length;
    } else if (ch === '<' && text[i + 1] === '>') {
      out.push({ word: '<>' });
      i += 2;
    } else if (ch === '=' || ch === '<' || ch === '>') {
      if (text[i + 1] === '=' || text[i + 1] === '>' || text[i + 1] === '<') {
        throw new ScriptError(`line ${line}: unsupported operator "${ch}${text[i + 1]}"`);
      }
      out.push({ word: ch });
      i++;
    } else if (ch === ';') {
      throw new ScriptError(`line ${line}: a comment must be on a line of its own`);
    } else {
      throw new ScriptError(`line ${line}: unexpected character "${ch}"`);
    }
  }
  return out;
}

function parse(script: string): Statement[] {
  if (script.includes('\r')) throw new ScriptError('script contains CR characters (line endings must be LF)');
  const statements: Statement[] = [];
  const labels = new Map<string, number>();
  const gotos: { stmt: Statement; label: string }[] = [];
  const ifStack: Statement[] = [];
  const lines = script.split('\n');

  const isWord = (t: Token | undefined, w?: string): t is { word: string } => t !== undefined && 'word' in t && (w === undefined || t.word === w);
  const isIdent = (t: Token | undefined): t is { word: string } => isWord(t) && /^[a-z_]/.test(t.word);
  const variable = (t: Token | undefined, line: number): Operand => {
    if (!isIdent(t)) throw new ScriptError(`line ${line}: expected a variable name`);
    if (RESERVED.has(t.word)) throw new ScriptError(`line ${line}: "${t.word}" is a reserved word and cannot be a variable`);
    return { kind: 'var', name: t.word };
  };
  const value = (t: Token | undefined, line: number): Operand => (t !== undefined && 'kind' in t ? t : variable(t, line));

  lines.forEach((raw, index) => {
    const line = index + 1;
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      if (code > 126 || (code < 32 && code !== 9)) throw new ScriptError(`line ${line}: non-ASCII or control character`);
    }
    const text = raw.trim();
    if (text === '' || text.startsWith(';')) return;
    if (text.startsWith(':')) {
      const name = text.slice(1).toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new ScriptError(`line ${line}: malformed label`);
      if (labels.has(name)) throw new ScriptError(`line ${line}: duplicate label "${name}"`);
      labels.set(name, statements.length);
      return;
    }
    const tokens = tokenize(text, line);
    const first = tokens[0];
    if (!isIdent(first)) throw new ScriptError(`line ${line}: expected a command`);
    const word = first.word;

    if (isWord(tokens[1], '=')) {
      const target = variable(first, line);
      const v = tokens[2];
      if (tokens.length !== 3 || v === undefined || !('kind' in v)) {
        throw new ScriptError(`line ${line}: only "name = integer" and "name = 'text'" assignments are supported`);
      }
      statements.push({ line, op: 'assign', args: [target, v] });
    } else if (word === 'if') {
      const op = tokens[2];
      if (tokens.length !== 5 || !isWord(op) || !['=', '<>', '<', '>'].includes(op.word) || !isWord(tokens[4], 'then')) {
        throw new ScriptError(`line ${line}: only "if A op B then" with op = <> < > is supported`);
      }
      const stmt: Statement = { line, op: 'if', args: [value(tokens[1], line), value(tokens[3], line)], cmp: op.word };
      ifStack.push(stmt);
      statements.push(stmt);
    } else if (word === 'endif') {
      if (tokens.length !== 1) throw new ScriptError(`line ${line}: unexpected text after endif`);
      const open = ifStack.pop();
      if (!open) throw new ScriptError(`line ${line}: endif without if`);
      open.jump = statements.length;
      statements.push({ line, op: 'endif', args: [] });
    } else if (word === 'exit') {
      if (tokens.length !== 1) throw new ScriptError(`line ${line}: unexpected text after exit`);
      statements.push({ line, op: 'exit', args: [] });
    } else if (word === 'goto') {
      const label = tokens[1];
      if (tokens.length !== 2 || !isIdent(label)) throw new ScriptError(`line ${line}: goto needs a label`);
      const stmt: Statement = { line, op: 'goto', args: [] };
      gotos.push({ stmt, label: label.word });
      statements.push(stmt);
    } else if (word in COMMAND_ARITY) {
      if (tokens.length !== COMMAND_ARITY[word] + 1) {
        throw new ScriptError(`line ${line}: ${word} takes ${COMMAND_ARITY[word]} argument(s)`);
      }
      statements.push({ line, op: word, args: tokens.slice(1).map((t) => value(t, line)) });
    } else {
      throw new ScriptError(`line ${line}: unknown command "${word}"`);
    }
  });

  if (ifStack.length) throw new ScriptError(`line ${ifStack[ifStack.length - 1].line}: if without endif`);
  for (const g of gotos) {
    const target = labels.get(g.label);
    if (target === undefined) throw new ScriptError(`line ${g.stmt.line}: unknown label "${g.label}"`);
    g.stmt.jump = target;
  }
  return statements;
}

const normalizePath = (p: string): string => p.replace(/\//g, '\\').toUpperCase();

export interface SimOptions {
  /** Guards against endless loops (default 10000 statements). */
  maxSteps?: number;
  /**
   * What `str2code` does with an empty string (which is also what reading a
   * 0x00 byte produces): store 0 (default, as Tera Term does) or leave the
   * variable unchanged. The camera's behaviour is not confirmed, so scripts
   * should work with both.
   */
  emptyStr2code?: 'zero' | 'unchanged';
}

/**
 * Run a start-up script against an in-memory file system (which is modified in
 * place).
 */
export function runScript(script: string, fs: SimFs, opts?: SimOptions): SimResult {
  const maxSteps = opts?.maxSteps ?? 10000;
  const keepOnEmpty = opts?.emptyStr2code === 'unchanged';
  const trace: string[] = [];
  let steps = 0;
  let statements: Statement[];
  try {
    statements = parse(script);
  } catch (e) {
    if (e instanceof ScriptError) return { steps, exited: false, error: e.message, trace };
    throw e;
  }

  const vars = new Map<string, number | string>([['result', 0]]);
  const handles = new Map<number, { key: string; pos: number; write: boolean }>();
  let nextHandle = 0;

  const findKey = (path: string): string | undefined => {
    const want = normalizePath(path);
    for (const key of fs.files.keys()) if (normalizePath(key) === want) return key;
    return undefined;
  };

  const run = (): boolean => {
    let pc = 0;
    while (pc < statements.length) {
      const st = statements[pc];
      if (++steps > maxSteps) throw new ScriptError(`line ${st.line}: step limit of ${maxSteps} exceeded (endless loop?)`);
      const fail = (message: string): never => {
        throw new ScriptError(`line ${st.line}: ${message}`);
      };
      const read = (o: Operand): number | string => {
        if (o.kind !== 'var') return o.value;
        const v = vars.get(o.name);
        if (v === undefined) return fail(`variable "${o.name}" is used before it is set`);
        return v;
      };
      const int = (o: Operand): number => {
        const v = read(o);
        return typeof v === 'number' ? v : fail('an integer is required here');
      };
      const str = (o: Operand): string => {
        const v = read(o);
        return typeof v === 'string' ? v : fail('a string is required here');
      };
      const varName = (o: Operand): string => (o.kind === 'var' ? o.name : fail('a variable is required here'));
      const handle = (o: Operand, write: boolean): { key: string; pos: number; write: boolean } => {
        const h = handles.get(int(o));
        if (!h) return fail('file handle is not open');
        if (h.write !== write) return fail(write ? 'file is not open for writing' : 'file is not open for reading');
        return h;
      };

      switch (st.op) {
        case 'assign':
          vars.set(varName(st.args[0]), read(st.args[1]));
          break;
        case 'if': {
          const a = int(st.args[0]);
          const b = int(st.args[1]);
          const truth = st.cmp === '=' ? a === b : st.cmp === '<>' ? a !== b : st.cmp === '<' ? a < b : a > b;
          if (!truth) pc = st.jump as number;
          break;
        }
        case 'endif':
          break;
        case 'goto':
          pc = st.jump as number;
          continue;
        case 'exit':
          return true;
        case 'filesearch': {
          const path = str(st.args[0]);
          const found = findKey(path) !== undefined;
          vars.set('result', found ? 1 : 0);
          trace.push(`filesearch ${path} -> ${found ? 1 : 0}`);
          break;
        }
        case 'filestat': {
          const path = str(st.args[0]);
          const name = varName(st.args[1]);
          const key = findKey(path);
          if (key !== undefined) {
            vars.set(name, (fs.files.get(key) as Uint8Array).length);
            vars.set('result', 0);
            trace.push(`filestat ${path} -> ${(fs.files.get(key) as Uint8Array).length}`);
          } else {
            vars.set('result', -1);
            trace.push(`filestat ${path} -> missing`);
          }
          break;
        }
        case 'fileopen': {
          const name = varName(st.args[0]);
          const path = str(st.args[1]);
          if (st.args[2].kind !== 'int' || st.args[2].value !== 0) fail('only "fileopen fh path 0" (read from the start) is supported');
          const key = findKey(path);
          if (key === undefined) {
            vars.set(name, -1);
            trace.push(`fileopen ${path} -> -1`);
          } else {
            const id = nextHandle++;
            handles.set(id, { key, pos: 0, write: false });
            vars.set(name, id);
            trace.push(`fileopen ${path} -> ${id}`);
          }
          break;
        }
        case 'fileread': {
          const h = handle(st.args[0], false);
          const n = int(st.args[1]);
          const name = varName(st.args[2]);
          if (n < 1 || n > 511) fail('fileread length must be 1..511');
          const data = fs.files.get(h.key) ?? new Uint8Array(0);
          const chunk = data.subarray(h.pos, h.pos + n);
          h.pos += chunk.length;
          let s = '';
          for (let i = 0; i < chunk.length && chunk[i] !== 0; i++) s += String.fromCharCode(chunk[i]);
          vars.set(name, s);
          vars.set('result', chunk.length === 0 ? 1 : 0);
          trace.push(`fileread ${h.key} ${n} -> ${chunk.length ? Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ') : 'eof'}`);
          break;
        }
        case 'str2code': {
          const name = varName(st.args[0]);
          const s = str(st.args[1]);
          if (s.length) vars.set(name, s.charCodeAt(0) & 0xff);
          else if (!keepOnEmpty) vars.set(name, 0);
          break;
        }
        case 'fileclose': {
          const id = int(st.args[0]);
          const h = handles.get(id);
          if (!h) return fail('file handle is not open');
          handles.delete(id);
          trace.push(`fileclose ${h.key}`);
          break;
        }
        case 'filecreate': {
          const name = varName(st.args[0]);
          const path = str(st.args[1]);
          if (fs.failCreate?.(path)) {
            vars.set(name, -1);
            trace.push(`filecreate ${path} -> -1`);
          } else {
            const key = findKey(path) ?? path;
            fs.files.set(key, new Uint8Array(0));
            const id = nextHandle++;
            handles.set(id, { key, pos: 0, write: true });
            vars.set(name, id);
            trace.push(`filecreate ${path} -> ${id}`);
          }
          break;
        }
        case 'filewrite': {
          const h = handle(st.args[0], true);
          const s = str(st.args[1]);
          const old = fs.files.get(h.key) ?? new Uint8Array(0);
          const data = new Uint8Array(old.length + s.length);
          data.set(old, 0);
          for (let i = 0; i < s.length; i++) data[old.length + i] = s.charCodeAt(i) & 0xff;
          fs.files.set(h.key, data);
          trace.push(`filewrite ${h.key} '${s}'`);
          break;
        }
        case 'filecopy': {
          const src = str(st.args[0]);
          const dst = str(st.args[1]);
          const srcKey = findKey(src);
          if (srcKey === undefined) {
            vars.set('result', -1);
            trace.push(`filecopy ${src} ${dst} -> source missing`);
          } else if (fs.failCopy?.(src, dst)) {
            vars.set('result', -1);
            trace.push(`filecopy ${src} ${dst} -> failed`);
          } else {
            fs.files.set(findKey(dst) ?? dst, (fs.files.get(srcKey) as Uint8Array).slice());
            vars.set('result', 0);
            trace.push(`filecopy ${src} ${dst} -> ok`);
          }
          break;
        }
        case 'strcompare': {
          const a = str(st.args[0]);
          const b = str(st.args[1]);
          vars.set('result', a === b ? 0 : a < b ? -1 : 1);
          break;
        }
        default:
          fail(`unknown command "${st.op}"`);
      }
      pc++;
    }
    return false;
  };

  try {
    const exited = run();
    if (handles.size > 0) {
      const open = [...handles.values()].map((h) => h.key).join(', ');
      return { steps, exited, error: `file handle left open at the end of the script: ${open}`, trace };
    }
    return { steps, exited, trace };
  } catch (e) {
    if (e instanceof ScriptError) return { steps, exited: false, error: e.message, trace };
    throw e;
  }
}
