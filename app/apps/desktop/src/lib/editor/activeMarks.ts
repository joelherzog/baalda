// Which markdown markers apply where the caret sits — the toolbar reads this to
// light its buttons up (`aria-pressed`).
//
// Inline marks come from the Lezer tree rather than a regex, so they are exactly
// what the parser (and therefore the live preview) sees. Block marks come from
// the line text via the same helpers the toggle commands use, so a button that
// reads "active" is always the button that will turn the marker back off.
//
// The result is a delimited string (`"|bold|h2|"`) instead of a Set on purpose:
// this is recomputed on every selection change, and React only needs to
// re-render when it differs — comparing two short strings is the cheapest way to
// know that.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { parseItem } from "./lists";

/** Lezer node name → toolbar mark id. */
const INLINE_NODES: Record<string, string> = {
  StrongEmphasis: "bold",
  Emphasis: "italic",
  InlineCode: "code",
  Strikethrough: "strike",
  Link: "link",
};

const HEADING_RE = /^\s*(#{1,6})\s+/;

/** True when `marks` (from `activeMarks`) contains the mark `id`. */
export function isActive(marks: string, id: string): boolean {
  return marks.includes(`|${id}|`);
}

/** The active marks at the primary cursor, as a delimited key like `"|bold|h2|"`. */
export function activeMarks(state: EditorState): string {
  const ids = new Set<string>();
  const pos = state.selection.main.head;

  // Walk out from the innermost node so nested emphasis (`***both***`) lights
  // up bold and italic together. `-1` biases to the node ending at the caret,
  // which is what you want right after typing the closing marker.
  for (let node = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent!) {
    const id = INLINE_NODES[node.name];
    if (id) ids.add(id);
    if (!node.parent) break;
  }

  const lineText = state.doc.lineAt(pos).text;
  const heading = HEADING_RE.exec(lineText);
  if (heading) ids.add(`h${heading[1].length}`);
  const item = parseItem(lineText);
  if (item) ids.add(item.kind);

  return ids.size === 0 ? "" : `|${[...ids].sort().join("|")}|`;
}
