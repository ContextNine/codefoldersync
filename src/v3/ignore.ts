import { hashText } from "../v2/hash.js";

export const defaultIgnore = `/.codefoldersync/
/.workspace-sync/
**/node_modules/
`;

interface Rule {
  readonly negate: boolean;
  readonly directory: boolean;
  readonly expression: RegExp;
}

export interface CompiledIgnore {
  readonly digest: string;
  readonly source: string;
  readonly ignores: (path: string, directory: boolean) => boolean;
}

export function compileIgnore(source: string): CompiledIgnore {
  const normalized = source.replaceAll("\r\n", "\n");
  const rules = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(parseRule);
  return {
    digest: hashText(normalized),
    source: normalized,
    ignores(path, directory) {
      const unix = path.replaceAll("\\", "/").replace(/^\//u, "");
      const first = unix.split("/")[0]?.toLocaleLowerCase("en-US");
      if (first === ".codefoldersync" || first === ".workspace-sync")
        return true;
      let ignored = false;
      for (const rule of rules) {
        if (rule.directory && !directory && !unix.includes("/")) continue;
        if (rule.expression.test(unix)) ignored = !rule.negate;
      }
      return ignored;
    },
  };
}

function parseRule(value: string): Rule {
  const negate = value.startsWith("!");
  const raw = negate ? value.slice(1) : value;
  if (raw.length === 0) throw new Error("Ignore negation requires a pattern");
  const directory = raw.endsWith("/");
  const anchored = raw.startsWith("/");
  const body = raw.replace(/^\//u, "").replace(/\/$/u, "");
  let expression = "";
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === "*") {
      if (body[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += escapeRegExp(character ?? "");
  }
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const suffix = directory ? "(?:/.*)?$" : "$";
  return {
    negate,
    directory,
    expression: new RegExp(`${prefix}${expression}${suffix}`, "u"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
