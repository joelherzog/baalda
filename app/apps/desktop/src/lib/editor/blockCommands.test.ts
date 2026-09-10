// The formatting toolbar's block commands. These are pure state transforms, so
// they run against a stand-in view (state + dispatch) rather than a real
// EditorView — no jsdom, and the assertions are on the resulting markdown,
// which is the thing that actually reaches disk and the CRDT.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { activeMarks, isActive } from "./activeMarks";
import {
  insertDivider,
  insertTable,
  toggleBullet,
  toggleHeading,
  toggleOrdered,
  toggleQuote,
  toggleTask,
} from "./blockCommands";
import { toggleBold, toggleItalic } from "./formatting";

const language = markdown({ base: markdownLanguage, extensions: [GFM] });

interface Harness {
  view: EditorView;
  doc: () => string;
}

/**
 * A minimal view: the commands only ever touch `state` and `dispatch`, and
 * driving them this way keeps the test in the node environment the rest of the
 * suite defaults to.
 */
function harness(doc: string, anchor = 0, head = anchor, extra: Extension[] = []): Harness {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [language, ...extra],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
    focus() {},
  } as unknown as EditorView;
  return { view, doc: () => state.doc.toString() };
}

/** Run a command over the whole document selected. */
function overAll(doc: string, run: Command): string {
  const h = harness(doc, 0, doc.length);
  run(h.view);
  return h.doc();
}

describe("heading toggles", () => {
  it("adds and removes the marker for the level clicked", () => {
    const h = harness("Title", 2);
    toggleHeading(2)(h.view);
    expect(h.doc()).toBe("## Title");
    toggleHeading(2)(h.view);
    expect(h.doc()).toBe("Title");
  });

  it("replaces a different level instead of stacking hashes", () => {
    const h = harness("### Deep", 5);
    toggleHeading(1)(h.view);
    expect(h.doc()).toBe("# Deep");
  });

  it("replaces a list marker rather than nesting inside it", () => {
    const h = harness("- an item", 4);
    toggleHeading(2)(h.view);
    expect(h.doc()).toBe("## an item");
  });

  it("keeps the indent of an indented line", () => {
    const h = harness("    Indented", 6);
    toggleHeading(3)(h.view);
    expect(h.doc()).toBe("    ### Indented");
  });
});

describe("list toggles", () => {
  it("bullets every selected line, then clears them all", () => {
    const src = "one\ntwo\nthree";
    const bulleted = overAll(src, toggleBullet);
    expect(bulleted).toBe("- one\n- two\n- three");
    expect(overAll(bulleted, toggleBullet)).toBe(src);
  });

  it("numbers a selection sequentially from 1", () => {
    expect(overAll("a\nb\nc", toggleOrdered)).toBe("1. a\n2. b\n3. c");
  });

  it("converts a bullet list to tasks without doubling the dash", () => {
    expect(overAll("- a\n- b", toggleTask)).toBe("- [ ] a\n- [ ] b");
  });

  it("adds the marker everywhere when the selection is mixed", () => {
    // "two" already has it, "one" does not → the click must format, not clear.
    expect(overAll("one\n- two", toggleBullet)).toBe("- one\n- two");
  });

  it("quotes and unquotes a paragraph", () => {
    const quoted = overAll("line one\nline two", toggleQuote);
    expect(quoted).toBe("> line one\n> line two");
    expect(overAll(quoted, toggleQuote)).toBe("line one\nline two");
  });

  it("leaves blank lines inside a selection unmarked", () => {
    expect(overAll("a\n\nb", toggleBullet)).toBe("- a\n\n- b");
  });

  it("clears a list that has a blank line in it", () => {
    // The blank line can never carry a marker, so it must not count against
    // "everything is already a bullet" — otherwise this toggle only ever adds.
    expect(overAll("- a\n\n- b", toggleBullet)).toBe("a\n\nb");
  });

  it("still formats a caret parked on an empty line", () => {
    const h = harness("", 0);
    toggleBullet(h.view);
    expect(h.doc()).toBe("- ");
  });
});

describe("insert commands", () => {
  it("uses the same table template as the slash menu", () => {
    const h = harness("", 0);
    insertTable(h.view);
    expect(h.doc()).toBe("| Column | Column |\n| --- | --- |\n|  |  |");
  });

  it("inserts a divider", () => {
    const h = harness("", 0);
    insertDivider(h.view);
    expect(h.doc()).toBe("---\n");
  });
});

describe("read-only documents", () => {
  const ro = [EditorState.readOnly.of(true)];

  it("refuses every command and leaves the text untouched", () => {
    for (const run of [toggleBullet, toggleQuote, toggleHeading(1), insertTable, toggleBold]) {
      const h = harness("untouched", 0, 9, ro);
      expect(run(h.view)).toBe(false);
      expect(h.doc()).toBe("untouched");
    }
  });
});

describe("inline commands exported for the toolbar", () => {
  it("wraps and unwraps a selection", () => {
    const h = harness("word", 0, 4);
    toggleBold(h.view);
    expect(h.doc()).toBe("**word**");
    toggleBold(h.view);
    expect(h.doc()).toBe("word");
  });

  // Documents a pre-existing quirk of `toggleInline`, unchanged by the toolbar:
  // `*` is a prefix of `**`, so italic over the inside of a bold span reads the
  // adjacent bold asterisks as its own markers and peels one off each side
  // rather than nesting. The toolbar button inherits exactly what ⌘I does.
  it("peels a bold marker when italic is applied inside one", () => {
    const h = harness("**word**", 2, 6);
    toggleItalic(h.view);
    expect(h.doc()).toBe("*word*");
  });

  it("italicises plain text and toggles back off", () => {
    const h = harness("word", 0, 4);
    toggleItalic(h.view);
    expect(h.doc()).toBe("*word*");
    toggleItalic(h.view);
    expect(h.doc()).toBe("word");
  });
});

describe("activeMarks", () => {
  it("reports the emphasis around the caret", () => {
    const h = harness("a **bold** b", 6);
    const marks = activeMarks(h.view.state);
    expect(isActive(marks, "bold")).toBe(true);
    expect(isActive(marks, "italic")).toBe(false);
  });

  it("reports the heading level and the list kind of the line", () => {
    expect(isActive(activeMarks(harness("## Title", 5).view.state), "h2")).toBe(true);
    expect(isActive(activeMarks(harness("- [ ] todo", 8).view.state), "task")).toBe(true);
    expect(isActive(activeMarks(harness("> quoted", 4).view.state), "quote")).toBe(true);
  });

  it("is empty in plain prose", () => {
    expect(activeMarks(harness("just text", 4).view.state)).toBe("");
  });

  it("cannot match a mark id as a substring of another", () => {
    expect(isActive("|h1|", "h")).toBe(false);
  });
});
