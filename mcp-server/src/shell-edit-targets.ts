import path from "node:path";

type ShellDialect = "posix" | "powershell";
interface Token { value: string; word: boolean; literal: boolean; body?: string }

/**
 * What one shell command line will write: the literal paths it names, and whether some write's target could not be
 * read (a variable, a glob, pipeline input, a location change the observation cannot follow, inline script code).
 */
export interface ShellWrites { paths: string[]; unknown: boolean }

const OPERATORS: Record<ShellDialect, RegExp> = {
  posix: /^(?:<<-|<<<|<<|>>|>\||>&|<&|&>>|&>|&&|\|\||[<>;|&()])/u,
  powershell: /^(?:>>|>&|&&|\|\||[<>;|&(){},])/u,
};
const WORD_BREAK: Record<ShellDialect, RegExp> = { posix: /[\s<>;|&()]/u, powershell: /[\s<>;|&(){},]/u };

/** A bounded syntax observation, not a shell interpreter or filesystem write monitor. */
function tokens(command: string, dialect: ShellDialect): Token[] {
  const result: Token[] = [];
  const heredocs: { delimiter: string; tabs: boolean; token: Token }[] = [];
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (character === "\n") {
      result.push({ value: "\n", word: false, literal: true });
      index++;
      for (const heredoc of heredocs.splice(0)) {
        const lines: string[] = [];
        while (index < command.length) {
          const end = command.indexOf("\n", index);
          const line = command.slice(index, end < 0 ? command.length : end).replace(/\r$/u, "");
          index = end < 0 ? command.length : end + 1;
          if ((heredoc.tabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) break;
          lines.push(line);
        }
        heredoc.token.body = lines.join("\n");
      }
      continue;
    }
    if (/\s/u.test(character)) { index++; continue; }
    if (character === "#") {
      const end = command.indexOf("\n", index);
      index = end < 0 ? command.length : end;
      continue;
    }
    const operator = OPERATORS[dialect].exec(command.slice(index));
    if (operator) {
      result.push({ value: operator[0], word: false, literal: true });
      index += operator[0].length;
      continue;
    }
    let value = "";
    let quote = "";
    let literal = true;
    while (index < command.length) {
      const next = command[index]!;
      if (!quote && WORD_BREAK[dialect].test(next)) break;
      if (next === "'" || next === '"') {
        if (!quote) { quote = next; index++; continue; }
        if (quote === next) {
          if (dialect === "powershell" && next === "'" && command[index + 1] === "'") {
            value += "'"; index += 2; continue;
          }
          quote = ""; index++; continue;
        }
      }
      const escape = dialect === "powershell" ? "`" : "\\";
      if (next === escape && quote !== "'" && index + 1 < command.length) {
        const escaped = command[index + 1]!;
        if (escaped !== "\n") value += escaped;
        index += 2; continue;
      }
      if (quote !== "'" && (next === "$" || (dialect === "posix" && next === "`")
        || (!quote && "*?~[]".includes(next)))) literal = false;
      value += next;
      index++;
    }
    if (quote) literal = false;
    const previous = result.at(-1);
    const token: Token = { value, word: true, literal };
    result.push(token);
    if (dialect === "posix" && (previous?.value === "<<" || previous?.value === "<<-")) {
      heredocs.push({ delimiter: value, tabs: previous.value === "<<-", token });
    }
  }
  return result;
}

/** Location state: "" is the hook's working directory, null a directory the observation cannot follow. */
interface Scan { dialect: ShellDialect; depth: number; cwd: string | null; paths: string[]; unknown: boolean }

const word = (value: string): Token => ({ value, word: true, literal: true });
const STDIN_WORD: Token = { value: "{}", word: true, literal: false };

function addPath(scan: Scan, token: Token | undefined, wildcards = false): void {
  if (!token?.word) return;
  const value = token.value;
  if (value === "/dev/null" || (scan.dialect === "powershell" && /^\$null$/iu.test(value))
    || (process.platform === "win32" && /^nul:?$/iu.test(value))) return;
  if (!token.literal || !value || (wildcards && /[*?[\]]/u.test(value))) { scan.unknown = true; return; }
  if (path.isAbsolute(value)) scan.paths.push(value);
  else if (scan.cwd === null) scan.unknown = true;
  else scan.paths.push(scan.cwd ? path.join(scan.cwd, value) : value);
}

/** `dest/<name of source>` for a copy or move into a directory. */
function addInto(scan: Scan, directory: Token, sources: Token[]): void {
  for (const source of sources) {
    if (!source.literal || !directory.literal) scan.unknown = true;
    else addPath(scan, word(path.join(directory.value, path.basename(source.value))));
  }
}

function changeLocation(scan: Scan, target: Token | undefined): void {
  if (!target || !target.literal || target.value === "-" || !target.value) scan.cwd = null;
  else if (path.isAbsolute(target.value)) scan.cwd = target.value;
  else scan.cwd = scan.cwd === null ? null : path.join(scan.cwd, target.value);
}

/** POSIX-style options and operands. `valued` names the options that take the next word. */
function operands(args: Token[], valued: ReadonlySet<string> = new Set()): { options: string[]; values: Map<string, Token>; rest: Token[] } {
  const options: string[] = [];
  const values = new Map<string, Token>();
  const rest: Token[] = [];
  let ended = false;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!ended && token.literal && token.value === "--") { ended = true; continue; }
    if (!ended && token.literal && /^-./u.test(token.value)) {
      const [name, inline] = token.value.split(/=(.*)/su, 2) as [string, string | undefined];
      options.push(name);
      if (inline !== undefined) values.set(name, word(inline));
      else if (valued.has(name) && args[index + 1]) values.set(name, args[++index]!);
      continue;
    }
    rest.push(token);
  }
  return { options, values, rest };
}

// Inline interpreter code that writes files. ponytail: a marker list, not a language parser; code without one of these
// calls (or a script file run by name) is not counted. Upgrade path: host write mediation (sandbox write events).
const SCRIPT_WRITES = [
  /\b(?:writeFile|appendFile|copyFile|createWriteStream|writeTextFile|write_text|write_bytes|file_put_contents)/u,
  /\b(?:unlink|rm|rmdir|rename|cp|truncate)Sync\s*\(/u,
  /\b(?:os\.(?:remove(?:dirs)?|unlink|renames?|replace|truncate)|shutil\.(?:copy\w*|move|rmtree))\s*\(/u,
  /\.(?:unlink|rename|rm|rmdir|touch|truncate)\s*\(/u,
  /\bf?open(?:Sync)?\s*\([^)]*?,\s*(?:mode\s*=\s*)?['"](?:[wax]|r\+)[bt+]*['"]/u,
  /\bopen\b[^;\n]*?['"]\+?>{1,2}/u,
  /\bFile\.(?:write|delete|rename)\b/u,
];
function inlineCode(scan: Scan, code: string | undefined): void {
  if (code !== undefined && SCRIPT_WRITES.some(pattern => pattern.test(code))) scan.unknown = true;
}

function nested(scan: Scan, command: string, dialect: ShellDialect): void {
  if (scan.depth >= 4) { scan.unknown = true; return; }
  const inner = scanCommand(command, dialect, scan.depth + 1, scan.cwd);
  scan.paths.push(...inner.paths);
  scan.unknown ||= inner.unknown;
}

const PS_ALIASES: Record<string, string> = {
  sc: "set-content", ac: "add-content", clc: "clear-content", ni: "new-item", cpi: "copy-item", copy: "copy-item",
  cp: "copy-item", mi: "move-item", move: "move-item", mv: "move-item", ri: "remove-item", rm: "remove-item",
  del: "remove-item", erase: "remove-item", rd: "remove-item", rmdir: "remove-item", rni: "rename-item",
  ren: "rename-item", tee: "tee-object", sl: "set-location", chdir: "set-location", cd: "set-location",
  pushd: "push-location", popd: "pop-location",
};
// Parameters that take a value; a parameter matching none of them by prefix is a switch (-Force, -Recurse, -NoNewline).
const PS_VALUED = ["path", "literalpath", "pspath", "lp", "filepath", "destination", "value", "encoding", "itemtype",
  "type", "name", "newname", "filter", "include", "exclude", "stream", "delimiter", "credential", "inputobject",
  "width", "variable", "erroraction", "ea", "warningaction", "wa", "errorvariable", "ev", "outvariable", "ov",
  "informationaction", "ia", "outbuffer", "ob", "pipelinevariable", "pv", "informationvariable", "iv",
  "warningvariable", "wv", "command", "encodedcommand", "file", "executionpolicy"];

/** PowerShell named parameters (by lowercase prefix) and positional arguments, `a, b` arrays kept together. */
function psParameters(args: Token[]): { named: [string, Token[]][]; positional: Token[][] } {
  const named: [string, Token[]][] = [];
  const positional: Token[][] = [];
  const array = (start: number): [Token[], number] => {
    const items = [args[start]!];
    let index = start + 1;
    while (args[index]?.value === "," && !args[index]?.word && args[index + 1]) { items.push(args[index + 1]!); index += 2; }
    return [items, index];
  };
  for (let index = 0; index < args.length;) {
    const token = args[index]!;
    const parameter = token.word && token.literal ? /^-([A-Za-z][\w-]*)(?::(.*))?$/su.exec(token.value) : null;
    if (!token.word) { index++; continue; }
    if (parameter) {
      const name = parameter[1]!.toLowerCase();
      if (parameter[2] !== undefined) { named.push([name, [word(parameter[2])]]); index++; continue; }
      if (!PS_VALUED.some(valued => valued.startsWith(name)) || !args[index + 1]?.word) { named.push([name, []]); index++; continue; }
      const [items, next] = array(index + 1);
      named.push([name, items]);
      index = next;
      continue;
    }
    const [items, next] = array(index);
    positional.push(items);
    index = next;
  }
  return { named, positional };
}

const psNamed = (named: [string, Token[]][], ...names: string[]) =>
  named.filter(([name]) => names.some(full => full.startsWith(name))).flatMap(([, value]) => value);

/** A PowerShell cmdlet or alias; false when the name is not one this observation knows. */
function powershellCommand(scan: Scan, name: string, args: Token[]): boolean {
  const cmdlet = PS_ALIASES[name] ?? name;
  const { named, positional } = psParameters(args);
  const literalPaths = psNamed(named, "literalpath", "pspath", "lp");
  const paths = (index = 0, ...names: string[]) => {
    const given = [...literalPaths.map(token => [token, false] as const),
      ...psNamed(named, "path", ...names).map(token => [token, true] as const)];
    return given.length > 0 ? given : (positional[index] ?? []).map(token => [token, true] as const);
  };
  const write = (targets: (readonly [Token, boolean])[]) => {
    if (targets.length === 0) scan.unknown = true;
    for (const [token, wildcards] of targets) addPath(scan, token, wildcards);
  };
  switch (cmdlet) {
    case "set-content": case "add-content": case "clear-content": case "out-file": case "remove-item":
      write(paths(0, "filepath")); return true;
    case "tee-object":
      if (psNamed(named, "variable").length === 0) write(paths(0, "filepath"));
      return true;
    case "new-item": {
      if (/^d/iu.test(psNamed(named, "itemtype", "type")[0]?.value ?? "")) return true;
      const names = psNamed(named, "name");
      if (names.length === 0) { write(paths()); return true; }
      for (const [directory] of paths().length > 0 ? paths() : [[word("."), false] as const]) addInto(scan, directory, names);
      return true;
    }
    case "copy-item": case "move-item": {
      if (cmdlet === "move-item") write(paths());
      const destination = psNamed(named, "destination");
      write((destination.length > 0 ? destination : positional[1] ?? []).map(token => [token, false] as const));
      return true;
    }
    case "rename-item": {
      const source = paths();
      write(source);
      const newName = psNamed(named, "newname")[0] ?? positional[1]?.[0];
      if (source.length !== 1 || !newName) scan.unknown = true;
      else addInto(scan, word(path.dirname(source[0]![0].value)), [newName]);
      return true;
    }
    case "set-location": case "push-location":
      changeLocation(scan, literalPaths[0] ?? psNamed(named, "path")[0] ?? positional[0]?.[0]); return true;
    case "pop-location": scan.cwd = null; return true;
  }
  return false;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const PREFIXES = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "nice", "time", "timeout", "stdbuf"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}"]);
const FILE_VALUED: Record<string, ReadonlySet<string>> = {
  truncate: new Set(["-s", "--size", "-r", "--reference"]),
  touch: new Set(["-d", "--date", "-t", "-r", "--reference"]),
  shred: new Set(["-n", "--iterations", "-s", "--size"]),
};
const CP_VALUED = new Set(["-t", "--target-directory", "-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]);

/** The native (non-cmdlet) commands: core file utilities, git's working-tree writers, shells and interpreters. */
function nativeCommand(scan: Scan, name: string, args: Token[], stdin: string | undefined): void {
  switch (name) {
    case "tee": case "rm": case "unlink": case "shred": case "touch": case "truncate":
      for (const token of operands(args, FILE_VALUED[name]).rest) addPath(scan, token);
      return;
    case "cp": case "mv": case "install": case "ln": {
      const { options, values, rest } = operands(args, CP_VALUED);
      if (name === "install" && options.includes("-d")) return;
      const directory = values.get("-t") ?? values.get("--target-directory");
      if (name === "mv") for (const token of directory ? rest : rest.slice(0, -1)) addPath(scan, token);
      if (directory) { addInto(scan, directory, rest); return; }
      const destination = rest.at(-1);
      if (!destination || rest.length < 2) return;
      if (rest.length > 2 || destination.value.endsWith("/")) addInto(scan, destination, rest.slice(0, -1));
      else addPath(scan, destination);
      return;
    }
    case "sed": case "gsed": {
      // BSD `sed -i '' …`: the empty suffix is not the script.
      const bsdSuffix = args.findIndex((token, index) => token.value === "-i" && args[index + 1]?.word && args[index + 1]?.value === "");
      const given = bsdSuffix < 0 ? args : args.filter((_token, index) => index !== bsdSuffix + 1);
      const { options, rest } = operands(given, new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]));
      if (!options.some(option => /^-[A-Za-z]*i/u.test(option) || option === "--in-place")) return;
      const script = options.some(option => ["-e", "--expression", "-f", "--file"].includes(option));
      const files = script ? rest : rest.slice(1);
      if (files.length === 0) scan.unknown = true;
      for (const token of files) addPath(scan, token);
      return;
    }
    case "dd":
      for (const token of args) if (token.value.startsWith("of=")) addPath(scan, { ...token, value: token.value.slice(3) });
      return;
    case "curl": case "wget": {
      const { options, values } = operands(args, new Set(["-o", "--output", "-O", "--output-document"].filter(option => name === "wget" || option !== "-O")));
      const output = name === "curl" ? values.get("-o") ?? values.get("--output") : values.get("-O") ?? values.get("--output-document");
      if (output) addPath(scan, output);
      else if (name === "wget" || options.some(option => option === "-O" || option === "--remote-name")) scan.unknown = true;
      return;
    }
    case "patch":
      if (!operands(args).options.includes("--dry-run")) scan.unknown = true;
      return;
    case "git": {
      const { rest: all } = operands(args, new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]));
      const start = args.indexOf(all[0]!);
      const sub = args[start]?.value;
      const subArgs = start < 0 ? [] : args.slice(start + 1);
      const { options, rest } = operands(subArgs);
      if (sub === "apply" && !options.some(option => ["--check", "--stat", "--numstat", "--summary"].includes(option))) scan.unknown = true;
      else if (sub === "mv") nativeCommand(scan, "mv", subArgs, undefined);
      else if (sub === "rm" && !options.includes("--cached")) for (const token of rest) addPath(scan, token);
      else if (sub === "restore" && (!options.some(option => option === "--staged" || option === "-S") || options.some(option => option === "--worktree" || option === "-W"))) {
        for (const token of rest) addPath(scan, token);
      } else if (sub === "checkout" && subArgs.some(token => token.value === "--")) {
        for (const token of subArgs.slice(subArgs.findIndex(token => token.value === "--") + 1)) addPath(scan, token);
      }
      return;
    }
    case "perl":
      if (args.some(token => token.literal && /^-[A-Za-z]*i/u.test(token.value))) scan.unknown = true;
      inlineCode(scan, args[args.findIndex(token => token.value === "-e" || token.value === "-E") + 1]?.value ?? stdin);
      return;
    case "eval":
      nested(scan, args.map(token => token.value).join(" "), "posix");
      return;
  }
  if (SHELLS.has(name)) {
    const flag = args.findIndex(token => token.literal && /^-[A-Za-z]*c$/u.test(token.value));
    const script = flag < 0 ? undefined : args[flag + 1];
    if (script) { nested(scan, script.value, "posix"); return; }
    if (stdin !== undefined && !operands(args).rest.length) nested(scan, stdin, "posix");
    return;
  }
  if (name === "pwsh" || name === "powershell") {
    const { named, positional } = psParameters(args);
    if (psNamed(named, "encodedcommand").length > 0 || named.some(([option]) => option === "e" || option === "ec" || option === "enc")) { scan.unknown = true; return; }
    const commandAt = args.findIndex(token => token.literal && /^-(?:c|co|com|comm|comma|comman|command)$/iu.test(token.value));
    if (commandAt >= 0) { nested(scan, args.slice(commandAt + 1).map(token => token.value).join(" "), "powershell"); return; }
    const first = positional[0]?.[0];
    if (first && psNamed(named, "file").length === 0 && !/\.ps1$/iu.test(first.value)) nested(scan, args.slice(args.indexOf(first)).map(token => token.value).join(" "), "powershell");
    return;
  }
  const codeAfter = (flags: string[]) => {
    const at = args.findIndex(token => flags.includes(token.value));
    return at < 0 ? undefined : args[at + 1]?.value;
  };
  const scriptOperand = () => args.some(token => token.word && !token.value.startsWith("-"));
  if (/^(?:python[\d.]*|py|pypy[\d.]*)$/u.test(name)) inlineCode(scan, codeAfter(["-c"]) ?? (args.some(token => token.value === "-m") || (scriptOperand() && !args.some(token => token.value === "-")) ? undefined : stdin));
  else if (["node", "nodejs", "bun"].includes(name)) inlineCode(scan, codeAfter(["-e", "--eval", "-p", "--print"]) ?? (scriptOperand() ? undefined : stdin));
  else if (name === "deno") inlineCode(scan, args[0]?.value === "eval" ? args[1]?.value : undefined);
  else if (name === "ruby") inlineCode(scan, codeAfter(["-e"]) ?? (scriptOperand() ? undefined : stdin));
  else if (name === "php") inlineCode(scan, codeAfter(["-r"]));
}

const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const OPERAND_REDIRECTS = new Set(["<", "<<", "<<-", "<<<", "<&", ">&"]);

/** One simple command: its redirections, any wrapper prefix, then the command's own writes. */
function simpleCommand(scan: Scan, tokens: Token[]): void {
  const args: Token[] = [];
  let stdin: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (!token.word && OUTPUT_REDIRECTS.has(token.value)) { addPath(scan, tokens[++index]); continue; }
    if (!token.word && OPERAND_REDIRECTS.has(token.value)) {
      const operand = tokens[++index];
      if (token.value === "<<<") stdin = operand?.value;
      else if (token.value.startsWith("<<")) stdin = operand?.body;
      continue;
    }
    args.push(token);
  }
  let index = 0;
  for (;;) {
    const current = args[index];
    if (!current?.word) return;
    const lower = current.value.toLowerCase();
    if (scan.dialect === "posix" && (KEYWORDS.has(current.value) || /^[A-Za-z_]\w*=/u.test(current.value))) { index++; continue; }
    if (PREFIXES.has(lower) || lower === "xargs") {
      // xargs appends the words it reads to the command: an operand the observation cannot read.
      if (lower === "xargs") args.push(STDIN_WORD);
      index++;
      while (args[index]?.word && (/^-/u.test(args[index]!.value) || /^\d+(?:\.\d+)?[smhd]?$/u.test(args[index]!.value)
        || (lower === "env" && /^[A-Za-z_]\w*=/u.test(args[index]!.value)))) index++;
      continue;
    }
    break;
  }
  const command = args[index]!;
  const name = path.basename(command.value.replaceAll("\\", "/")).toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
  const rest = args.slice(index + 1);
  if (scan.dialect === "posix" && ["cd", "pushd", "chdir"].includes(name)) changeLocation(scan, operands(rest).rest[0]);
  else if (scan.dialect === "posix" && name === "popd") scan.cwd = null;
  else if (scan.dialect === "powershell" && /^\[(?:system\.)?io\.(?:file|directory)\]::(?:write|append|copy|move|delete|replace|create)/iu.test(command.value)) scan.unknown = true;
  else if (scan.dialect !== "powershell" || !powershellCommand(scan, name, rest)) nativeCommand(scan, name, rest, stdin);
  if (name === "find") {
    if (rest.some(token => token.value === "-delete")) scan.unknown = true;
    // Each `-exec … {} ;` runs its command on found files: `{}` is an operand the observation cannot read.
    rest.forEach((token, at) => {
      if (!["-exec", "-execdir", "-ok", "-okdir"].includes(token.value)) return;
      const end = rest.findIndex((next, after) => after > at && (next.value === ";" || next.value === "+"));
      const inner = rest.slice(at + 1, end < 0 ? rest.length : end).map(next => next.value === "{}" ? STDIN_WORD : next);
      simpleCommand(scan, inner.includes(STDIN_WORD) ? inner : [...inner, STDIN_WORD]);
    });
  }
}

const BOUNDARIES = new Set([";", "\n", "|", "&", "&&", "||", "(", ")", "{", "}"]);

function scanCommand(command: string, dialect: ShellDialect, depth: number, cwd: string | null): ShellWrites {
  const scan: Scan = { dialect, depth, cwd, paths: [], unknown: false };
  const saved: (string | null)[] = [];
  let current: Token[] = [];
  for (const token of tokens(command, dialect)) {
    if (token.word || !BOUNDARIES.has(token.value)) { current.push(token); continue; }
    simpleCommand(scan, current);
    current = [];
    // A POSIX `( … )` subshell's location change ends with it; PowerShell parentheses do not scope Set-Location.
    if (dialect === "posix" && token.value === "(") saved.push(scan.cwd);
    if (dialect === "posix" && token.value === ")" && saved.length > 0) scan.cwd = saved.pop()!;
  }
  simpleCommand(scan, current);
  return scan;
}

/**
 * Prospective write targets of a shell command (design: AGS3-D-0005). Literal paths named by output redirections, file
 * utilities (tee, cp, mv, rm, touch, sed -i, dd, git apply/mv/rm/restore), PowerShell content and item cmdlets, nested
 * `sh -c`/`pwsh -Command` text and heredoc stdin are returned. A write whose target cannot be read sets `unknown` so the
 * edit gate counts it conservatively. Read-only commands return null. `either` scans both dialects for a host whose
 * shell is not named in the hook input.
 */
export function shellEditTargets(command: unknown, dialect: ShellDialect | "either"): ShellWrites | null {
  if (typeof command !== "string") return null;
  // A POSIX heredoc body is data; the PowerShell reading of the same text would parse it as commands.
  const dialects = dialect !== "either" ? [dialect] : /<<-?\s*['"]?[\w-]/u.test(command) ? ["posix"] as const : ["posix", "powershell"] as const;
  const scans = dialects.map(given => scanCommand(command, given, 0, ""));
  const paths = [...new Set(scans.flatMap(scan => scan.paths))];
  const unknown = scans.some(scan => scan.unknown);
  return paths.length > 0 || unknown ? { paths, unknown } : null;
}
