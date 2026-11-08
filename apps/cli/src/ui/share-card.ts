import { renderMarkdownToLines } from "./markdown.ts";

/** Render the Markdown source richly for terminal output while keeping the source copyable. */
export function renderShareCard(card: string): string {
  return renderMarkdownToLines(card).join("\n");
}
