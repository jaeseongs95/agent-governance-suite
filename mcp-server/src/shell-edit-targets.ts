type ShellDialect = "posix" | "powershell";
interface Token { value: string; word: boolean; literal: boolean }

/** A bounded syntax observation, not a shell interpreter or filesystem write monitor. */
function tokens(command: string, dialect: ShellDialect): Token[] {
  const result: Token[] = [];
  const heredocs: { delimiter: string; tabs: boolean }[] = [];
  let index = 0;
  while (index < command.length) {
    const character = command[index]!;
    if (character === "\n") {
      result.push({ value: "\n", word: false, literal: true });
      index++;
      for (const heredoc of heredocs.splice(0)) {
        while (index < command.length) {
          const end = command.indexOf("\n", index);
          const line = command.slice(index, end < 0 ? command.length : end).replace(/\r$/u, "");
          index = end < 0 ? command.length : end + 1;
          if ((heredoc.tabs ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) break;
        }
      }
      continue;
    }
    if (/\s/u.test(character)) { index++; continue; }
    if (character === "#") {
      const end = command.indexOf("\n", index);
      index = end < 0 ? command.length : end;
      continue;
    }
    const operator = /^(?:<<-|<<<|<<|>>|>\||>&|<&|&>|&&|\|\||[<>;|&(){},])/u.exec(command.slice(index));
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
      if (!quote && /[\s<>;|&(){},]/u.test(next)) break;
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
    result.push({ value, word: true, literal });
    if (dialect === "posix" && (previous?.value === "<<" || previous?.value === "<<-")) {
      heredocs.push({ delimiter: value, tabs: previous.value === "<<-" });
    }
  }
  return result;
}

const CONTENT_WRITERS = new Set(["set-content", "add-content", "out-file"]);
const COMPLEX_COMMANDS = new Set(["if", "for", "foreach", "while", "until", "case", "function", "eval", "source", ".", "cd", "pushd", "popd", "set-location", "push-location", "pop-location"]);
const COMMAND_BOUNDARIES = new Set([";", "\n", "|", "&"]);

/**
 * Prospective literal write paths: output redirections and named PowerShell content-writer paths. Quoted text,
 * comments and POSIX heredoc bodies are data, not commands. Unknown/dynamic paths are not fabricated file names.
 * ponytail: arbitrary scripts, aliases, control flow and location changes need host write mediation; this limited
 * observation deliberately leaves them unclassified instead of counting every shell command as an edit.
 */
export function shellEditTargets(command: unknown, dialect: ShellDialect): string[] | null {
  if (typeof command !== "string") return null;
  const parsed = tokens(command, dialect);
  let commandStart = true;
  for (const token of parsed) {
    if (!token.word && ["(", ")", "{", "}", "&&", "||"].includes(token.value)) return null;
    if (!token.word && COMMAND_BOUNDARIES.has(token.value)) { commandStart = true; continue; }
    if (commandStart && token.word) {
      if (COMPLEX_COMMANDS.has(token.value.toLowerCase())) return null;
      commandStart = false;
    }
  }
  const paths: string[] = [];
  const add = (token: Token | undefined, wildcardPath = false) => {
    if (!token?.word || !token.literal || !token.value || token.value === "/dev/null") return;
    if (process.platform === "win32" && /^nul:?$/iu.test(token.value)) return;
    if (wildcardPath && /[*?[\]]/u.test(token.value)) return;
    paths.push(token.value);
  };
  commandStart = true;
  let writer = "";
  for (const [index, token] of parsed.entries()) {
    if (!token.word && COMMAND_BOUNDARIES.has(token.value)) { commandStart = true; writer = ""; continue; }
    if (commandStart && token.word) { writer = token.value.toLowerCase(); commandStart = false; }
    if (!token.word && [">", ">>", ">|", "&>"].includes(token.value)) add(parsed[index + 1]);
    if (dialect === "powershell" && CONTENT_WRITERS.has(writer) && token.word
      && /^-(?:literalpath|path|filepath)$/iu.test(token.value)) {
      const wildcardPath = token.value.toLowerCase() === "-path";
      add(parsed[index + 1], wildcardPath);
      let next = index + 2;
      while (parsed[next]?.value === "," && !parsed[next]?.word) { add(parsed[next + 1], wildcardPath); next += 2; }
    }
  }
  return paths.length > 0 ? [...new Set(paths)] : null;
}
