import chalk from "chalk";

const INDENT = "  ";
// Private-use character that stands in for an extracted code span while emphasis is parsed.
const CODE_MARK = String.fromCharCode(0xe000);
const CODE_MARK_PATTERN = new RegExp(`${CODE_MARK}(\\d+)${CODE_MARK}`, "g");

export function renderMarkdownToLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const rendered: string[] = [];
  let inCodeBlock = false;
  let codeFenceLanguage = "";

  for (const line of lines) {
    const fenceMatch = line.trim().match(/^```\s*([\w.+-]+)?\s*$/);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeFenceLanguage = fenceMatch[1] ?? "";
        rendered.push(chalk.dim(`┌─ code${codeFenceLanguage ? ` (${codeFenceLanguage})` : ""}`));
      } else {
        inCodeBlock = false;
        codeFenceLanguage = "";
        rendered.push(chalk.dim("└─ end"));
      }
      continue;
    }

    if (inCodeBlock) {
      rendered.push(`${chalk.dim("│")} ${chalk.cyan(line || " ")}`);
      continue;
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      rendered.push(chalk.dim("─".repeat(32)));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const prefix = level <= 2 ? "◆" : "•";
      rendered.push(chalk.bold(`${prefix} ${renderInlineMarkdown(headingMatch[2] ?? "")}`));
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      rendered.push(chalk.dim(`│ ${renderInlineMarkdown(quoteMatch[1] ?? "")}`));
      continue;
    }

    const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bulletMatch) {
      const indent = Math.floor((bulletMatch[1] ?? "").length / 2);
      rendered.push(`${INDENT.repeat(indent)}• ${renderInlineMarkdown(bulletMatch[2] ?? "")}`);
      continue;
    }

    const orderedMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
      const indent = Math.floor((orderedMatch[1] ?? "").length / 2);
      rendered.push(
        `${INDENT.repeat(indent)}${orderedMatch[2]}. ${renderInlineMarkdown(orderedMatch[3] ?? "")}`,
      );
      continue;
    }

    const tableLike = /^\|(.+)\|$/.test(line.trim());
    if (tableLike) {
      rendered.push(chalk.gray(line));
      continue;
    }

    rendered.push(renderInlineMarkdown(line));
  }

  return rendered;
}

function renderInlineMarkdown(line: string): string {
  // Code spans are lifted out first so `_` and `*` inside them are never read as emphasis.
  const codeSpans: string[] = [];
  let output = line.replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(chalk.bgHex("#1f2430").cyan(` ${code} `));
    return `${CODE_MARK}${codeSpans.length - 1}${CODE_MARK}`;
  });

  output = output.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, (_, strong: string) => chalk.bold(strong));
  output = output.replace(
    /(?<![A-Za-z0-9_])__(?=\S)([^_]*?\S)__(?![A-Za-z0-9_])/g,
    (_, strong: string) => chalk.bold(strong),
  );
  // An opening `*` must touch the text, so `2 * 3 * 4` stays arithmetic.
  output = output.replace(/\*(?=\S)([^*]*?\S)\*/g, (_, emphasis: string) => chalk.italic(emphasis));
  // Underscores inside identifiers (snake_case) are not emphasis.
  output = output.replace(
    /(?<![A-Za-z0-9_])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9_])/g,
    (_, emphasis: string) => chalk.italic(emphasis),
  );
  output = output.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, label: string, url: string) => `${chalk.blue.underline(label)} ${chalk.dim(url)}`,
  );

  return output.replace(CODE_MARK_PATTERN, (_, index: string) => codeSpans[Number(index)] ?? "");
}
