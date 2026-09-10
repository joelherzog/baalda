// Slash-command block menu. Type `/` at the start of a line to open a menu of
// block templates (headings, lists, tasks, quote, code, table, divider). It
// reuses CodeMirror's autocomplete surface, so it looks and keys like the
// `[[wiki-link]]` menu. Each option replaces the `/query` it was triggered from
// with the block's markdown and parks the caret where you'd start typing.

import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Build an `apply` that replaces the trigger with `insert`, caret at `caret`
 *  (offset from the insert start) or selecting [selFrom, selTo). */
function applyBlock(
  insert: string,
  caret: number,
  selTo?: number
): (view: EditorView, c: Completion, from: number, to: number) => void {
  return (view, _c, from, to) => {
    view.dispatch({
      changes: { from, to, insert },
      selection:
        selTo != null
          ? EditorSelection.range(from + caret, from + selTo)
          : EditorSelection.cursor(from + caret),
      scrollIntoView: true,
      userEvent: "input.complete",
    });
  };
}

export interface Block {
  label: string;
  detail: string;
  keywords: string;
  insert: string;
  caret: number;
  selTo?: number;
}

export const BLOCKS: Block[] = [
  { label: "Heading 1", detail: "#", keywords: "h1 title", insert: "# ", caret: 2 },
  { label: "Heading 2", detail: "##", keywords: "h2", insert: "## ", caret: 3 },
  { label: "Heading 3", detail: "###", keywords: "h3", insert: "### ", caret: 4 },
  { label: "Bullet list", detail: "-", keywords: "ul unordered", insert: "- ", caret: 2 },
  { label: "Numbered list", detail: "1.", keywords: "ol ordered", insert: "1. ", caret: 3 },
  { label: "Task", detail: "- [ ]", keywords: "todo checkbox", insert: "- [ ] ", caret: 6 },
  { label: "Quote", detail: ">", keywords: "blockquote", insert: "> ", caret: 2 },
  {
    label: "Code block",
    detail: "```",
    keywords: "fence pre",
    insert: "```\n\n```",
    caret: 4, // inside the fences (after "```\n")
  },
  {
    label: "Table",
    detail: "columns",
    keywords: "grid",
    insert: "| Column | Column |\n| --- | --- |\n|  |  |",
    caret: 2, // select the first header cell
    selTo: 8,
  },
  { label: "Divider", detail: "---", keywords: "hr rule separator", insert: "---\n", caret: 4 },
];

/** Look a block template up by its menu label (the toolbar's entry point). */
export function findBlock(label: string): Block {
  const block = BLOCKS.find((b) => b.label === label);
  if (!block) throw new Error(`unknown block template: ${label}`);
  return block;
}

/**
 * Insert a block template at the caret, replacing the current selection. Same
 * transaction shape as the slash menu's `applyBlock`, so a toolbar button and
 * `/Table` produce byte-identical markdown.
 */
export function insertBlock(view: EditorView, block: Block): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  applyBlock(block.insert, block.caret, block.selTo)(view, EMPTY_COMPLETION, from, to);
  return true;
}

const EMPTY_COMPLETION: Completion = { label: "" };

const COMPLETIONS: Completion[] = BLOCKS.map((b) => ({
  label: `/${b.label}`,
  detail: b.detail,
  type: "keyword",
  apply: applyBlock(b.insert, b.caret, b.selTo),
}));

/** Completion source: only fires for a `/…` that begins a line. */
export function slashCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\/\w*/);
  if (!before) return null;
  // The `/` must be the first non-space char on the line (a block trigger),
  // not a slash mid-sentence (dates, paths, "and/or").
  const line = context.state.doc.lineAt(before.from);
  if (before.from !== line.from + (/^\s*/.exec(line.text)?.[0].length ?? 0)) {
    return null;
  }
  if (before.from === before.to && !context.explicit) return null;

  const typed = before.text.slice(1).toLowerCase();
  const options = COMPLETIONS.filter((_, i) => {
    if (!typed) return true;
    const b = BLOCKS[i];
    return (
      b.label.toLowerCase().includes(typed) || b.keywords.includes(typed)
    );
  });

  return { from: before.from, to: before.to, options, filter: false };
}
