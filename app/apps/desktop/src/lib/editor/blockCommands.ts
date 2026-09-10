// Block-level markdown toggles — the commands behind the formatting toolbar's
// heading, list, task, quote and insert buttons.
//
// The keyboard has no shortcuts for these (`lists.ts` only continues a list you
// already started, `slash.ts` only inserts at a `/` trigger), so the toolbar is
// their first caller. They are plain CodeMirror commands producing plain
// transactions, which means yCollab picks them up and syncs them exactly like
// typed text — no whole-line rewrite, no CRDT special case.
//
// Two rules keep the behaviour predictable:
//   1. Block markers are mutually exclusive. Making a heading out of a bullet
//      replaces the marker rather than stacking `- # text`, which is what every
//      other editor does and what the live preview can render.
//   2. Over a multi-line selection the decision is made once for the whole
//      selection: remove the marker only when *every* affected line already has
//      it, otherwise add it everywhere. Mixed selections converge on "add",
//      so one click never half-formats a block.

import type { ChangeSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { type ItemKind, parseItem } from "./lists";
import { findBlock, insertBlock } from "./slash";

/** `# ` … `###### ` at the start of a line. Group 1 is the hashes. */
const HEADING_RE = /^(\s*)(#{1,6})\s+/;

/** A line split into its indent and its body with any block marker removed. */
interface Stripped {
  indent: string;
  body: string;
}

/**
 * Remove whatever block marker a line carries — heading hashes, a bullet, an
 * ordered marker, a task box, or a blockquote `>` — and return the bare text.
 */
function stripMarker(lineText: string): Stripped {
  const heading = HEADING_RE.exec(lineText);
  if (heading) {
    return { indent: heading[1], body: lineText.slice(heading[0].length) };
  }
  const item = parseItem(lineText);
  if (item) {
    return { indent: item.indent, body: lineText.slice(item.bodyStart) };
  }
  const indent = /^\s*/.exec(lineText)?.[0] ?? "";
  return { indent, body: lineText.slice(indent.length) };
}

/** The heading level a line already carries, or 0 for a non-heading. */
function headingLevel(lineText: string): number {
  return HEADING_RE.exec(lineText)?.[2].length ?? 0;
}

/** The list/quote kind a line already carries, or null. */
function itemKind(lineText: string): ItemKind | null {
  return parseItem(lineText)?.kind ?? null;
}

/**
 * Every line touched by the selection, deduplicated and in document order. A
 * caret counts as its own line; a range ending exactly at a line start does not
 * pull that line in (selecting to the end of line 3 must not format line 4).
 */
function selectedLines(view: EditorView) {
  const { doc } = view.state;
  const numbers = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const lastPos = range.empty ? range.to : Math.max(range.from, range.to - 1);
    const last = doc.lineAt(lastPos).number;
    for (let n = first; n <= last; n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b).map((n) => doc.line(n));
}

/**
 * Rewrite the selected lines' block markers.
 *
 * `has` reports whether a line already carries the target marker; `marker`
 * builds the prefix for the nth line being formatted (nth so ordered lists can
 * count). Blank lines are left alone when adding — a marker on the empty line
 * after a paragraph is noise — unless the selection is nothing but blank lines,
 * which is the "start a list here" case.
 */
function toggleBlock(
  has: (lineText: string) => boolean,
  marker: (nth: number) => string
): Command {
  return (view) => {
    if (view.state.readOnly) return false;
    const lines = selectedLines(view);
    if (lines.length === 0) return false;

    // Blank lines never carry a marker, so they must not be part of the
    // "does everything already have it?" vote — otherwise a bulleted list with
    // a blank line in the middle could never be switched back off.
    const filled = lines.filter((line) => line.text.trim() !== "");
    const remove = filled.length > 0 && filled.every((line) => has(line.text));
    // A marker on the blank line after a paragraph is noise, so blanks are
    // skipped — except when the selection is nothing but blanks, which is the
    // "start a list right here" case.
    const targets = filled.length === 0 ? lines : filled;

    const changes: ChangeSpec[] = [];
    let nth = 0;
    for (const line of targets) {
      const { indent, body } = stripMarker(line.text);
      const next = remove ? `${indent}${body}` : `${indent}${marker(nth++)}${body}`;
      if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
    }
    if (changes.length === 0) return false;

    // No explicit selection: CodeMirror maps the existing one through the
    // changes, which keeps the caret on the same character of the same word.
    view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
    return true;
  };
}

/** `#`×level — toggling the level a line already has strips it back to text. */
export function toggleHeading(level: 1 | 2 | 3 | 4 | 5 | 6): Command {
  const prefix = `${"#".repeat(level)} `;
  return toggleBlock((text) => headingLevel(text) === level, () => prefix);
}

export const toggleBullet = toggleBlock((t) => itemKind(t) === "bullet", () => "- ");
export const toggleTask = toggleBlock((t) => itemKind(t) === "task", () => "- [ ] ");
export const toggleQuote = toggleBlock((t) => itemKind(t) === "quote", () => "> ");
export const toggleOrdered = toggleBlock(
  (t) => itemKind(t) === "ordered",
  (nth) => `${nth + 1}. `
);

/** Insert commands, sharing the slash menu's templates (`slash.ts` `BLOCKS`). */
function insertTemplate(label: string): Command {
  return (view) => insertBlock(view, findBlock(label));
}

export const insertCodeBlock = insertTemplate("Code block");
export const insertTable = insertTemplate("Table");
export const insertDivider = insertTemplate("Divider");
