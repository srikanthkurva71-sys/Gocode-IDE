/**
 * Split a user-entered executable argument string without invoking a shell.
 * Supports single/double quoted arguments and escaped matching quotes. Backslashes
 * in Windows paths are preserved unless escaping a quote or another backslash.
 */
export function parseCommandLineArguments(input: string): string[] {
  if (typeof input !== "string") throw new Error("Arguments must be text.");
  if (input.length > 16_384) throw new Error("Argument text exceeds the 16 KiB limit.");

  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index];

    if (quote) {
      if (character === quote) {
        quote = null;
        started = true;
        continue;
      }
      if (character === "\\" && index + 1 < input.length) {
        const next = input[index + 1];
        if (next === quote || next === "\\") {
          current += next;
          index++;
          started = true;
          continue;
        }
      }
      current += character;
      started = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }

  if (quote) throw new Error("Argument text contains an unmatched quote.");
  if (started) args.push(current);
  if (args.length > 256) throw new Error("Too many executable arguments (maximum 256).");
  return args;
}
