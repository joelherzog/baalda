// The note editor's formatting toolbar.
//
// It owns no editing logic. Every button fires a CodeMirror `Command` that
// already exists — the same ones the keyboard shortcuts and the `/` block menu
// fire (`lib/editor/formatting.ts`, `lib/editor/blockCommands.ts`) — so there is
// exactly one implementation of "make this bold" in the app and the toolbar
// cannot drift from the keys. Because those commands dispatch ordinary
// transactions, a toolbar click reaches collaborators and the `.md` on disk by
// the same path as a typed character.
//
// The one piece of real behaviour here is focus: a button must not steal the
// selection it is about to format, hence `onMouseDown` preventDefault on each.

import type { EditorView } from "@codemirror/view";
import {
  insertCodeBlock,
  insertDivider,
  insertTable,
  toggleBullet,
  toggleHeading,
  toggleOrdered,
  toggleQuote,
  toggleTask,
} from "../lib/editor/blockCommands";
import { isActive } from "../lib/editor/activeMarks";
import {
  insertLink,
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleStrike,
} from "../lib/editor/formatting";
import { platformClass } from "../lib/platform";

export interface EditorToolbarProps {
  /** The live editor, or null while a note is still opening. */
  getView: () => EditorView | null;
  /** Locked, view-only, or covered by the version preview. */
  disabled: boolean;
  /** Active marks at the caret, from `activeMarks()`. */
  marks: string;
}

type Command = (view: EditorView) => boolean;

interface Item {
  /** Mark id from `activeMarks`, or undefined for buttons with no on-state. */
  mark?: string;
  label: string;
  /** Shortcut suffix for the tooltip, e.g. "B" → "⌘B". */
  key?: string;
  run: Command;
  icon: React.JSX.Element;
}

// Inline SVG rather than an icon dependency — the app has no icon library and
// draws its handful of glyphs the same way (see the lock banner in Editor.tsx).
const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * A lettered glyph. Some of these read far better as a letter than as an
 * outline at 16px — "H2" is instantly a heading, and a struck-through "S" is
 * instantly strikethrough, where a drawn squiggle is a guess.
 */
function textIcon(text: string, strike = false): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fill="currentColor"
      >
        {text}
      </text>
      {strike && (
        <path d="M4 12h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}

const GROUPS: Item[][] = [
  [
    {
      mark: "bold",
      label: "Bold",
      key: "B",
      run: toggleBold,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <path d="M7 5h6.5a3.5 3.5 0 0 1 0 7H7z" />
          <path d="M7 12h7.5a3.5 3.5 0 0 1 0 7H7z" />
        </svg>
      ),
    },
    {
      mark: "italic",
      label: "Italic",
      key: "I",
      run: toggleItalic,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <path d="M15 5h-5M14 19H9M14 5l-4 14" />
        </svg>
      ),
    },
    {
      mark: "strike",
      label: "Strikethrough",
      key: "⇧X",
      run: toggleStrike,
      icon: textIcon("S", true),
    },
    {
      mark: "code",
      label: "Inline code",
      key: "E",
      run: toggleInlineCode,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <path d="m9 8-5 4 5 4M15 8l5 4-5 4" />
        </svg>
      ),
    },
    {
      mark: "link",
      label: "Link",
      key: "K",
      run: insertLink,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <path d="M10 13.5a4 4 0 0 0 5.7.3l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
          <path d="M14 10.5a4 4 0 0 0-5.7-.3l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" />
        </svg>
      ),
    },
  ],
  [
    { mark: "h1", label: "Heading 1", run: toggleHeading(1), icon: textIcon("H1") },
    { mark: "h2", label: "Heading 2", run: toggleHeading(2), icon: textIcon("H2") },
    { mark: "h3", label: "Heading 3", run: toggleHeading(3), icon: textIcon("H3") },
  ],
  [
    {
      mark: "bullet",
      label: "Bullet list",
      run: toggleBullet,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      mark: "ordered",
      label: "Numbered list",
      run: toggleOrdered,
      icon: (
        <svg {...stroke} aria-hidden="true" strokeWidth={1.7}>
          <path d="M10 6h10M10 12h10M10 18h10" />
          {/* 1 · 2 · 3. Digit strokes only — the baseline serifs a numeral
              would normally carry just turn to mush at 16px. */}
          <path d="M4.2 5 5.3 4.3v3.5" strokeWidth={1.5} />
          <path d="M4.2 10.7c.2-1 2.2-.9 2.2.3 0 .9-2.2 1.5-2.2 2.6h2.4" strokeWidth={1.5} />
          <path d="M4.2 16.3h2.2l-1.2 1.3a1.05 1.05 0 1 1-1 1.3" strokeWidth={1.5} />
        </svg>
      ),
    },
    {
      mark: "task",
      label: "Task",
      run: toggleTask,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <rect x="3" y="4" width="8" height="8" rx="2" />
          <path d="m5.2 8.1 1.7 1.7L9.2 6.6" />
          <path d="M14 8h7M3 17h18" />
        </svg>
      ),
    },
    {
      mark: "quote",
      label: "Quote",
      run: toggleQuote,
      icon: (
        <svg {...stroke} aria-hidden="true">
          {/* Two quote marks — unmistakably a quote, where a left bar plus
              lines reads as "indent". */}
          <path d="M9.5 7.5c-2.6 0-4 1.7-4 4 0 1.7 1.1 2.9 2.6 2.9s2.4-1 2.4-2.3c0-1.2-.8-2.1-2-2.2.2-1 1-1.6 2-1.7z" />
          <path d="M18.5 7.5c-2.6 0-4 1.7-4 4 0 1.7 1.1 2.9 2.6 2.9s2.4-1 2.4-2.3c0-1.2-.8-2.1-2-2.2.2-1 1-1.6 2-1.7z" />
        </svg>
      ),
    },
  ],
  [
    {
      label: "Code block",
      run: insertCodeBlock,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          {/* Indented lines rather than chevrons — the inline-code button next
              to it already owns the `<>` shape. */}
          <path d="M6.5 9h6M9 12.5h7M6.5 16h4.5" strokeWidth={1.7} />
        </svg>
      ),
    },
    {
      label: "Table",
      run: insertTable,
      icon: (
        <svg {...stroke} aria-hidden="true">
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          <path d="M3 9.5h18M3 14.5h18M10 9.5v10" />
        </svg>
      ),
    },
    {
      label: "Divider",
      run: insertDivider,
      icon: (
        <svg {...stroke} aria-hidden="true">
          {/* The rule is solid and full width; the text it separates is dashed
              and inset, so this cannot be mistaken for a list. */}
          <path d="M3 12h18" strokeWidth={2.2} />
          <path d="M6 6.5h12M6 17.5h12" strokeWidth={1.6} strokeDasharray="3 3" opacity="0.5" />
        </svg>
      ),
    },
  ],
];

/** "⌘B" on macOS, "Ctrl+B" elsewhere — matches what `Mod-b` actually binds to. */
function shortcut(key: string): string {
  return platformClass() === "macos" ? `⌘${key}` : `Ctrl+${key.replace("⇧", "Shift+")}`;
}

export function EditorToolbar(props: EditorToolbarProps): React.JSX.Element {
  const { getView, disabled, marks } = props;

  const fire = (run: Command) => {
    const view = getView();
    if (!view) return;
    run(view);
    // The command may be a no-op (nothing to toggle); focus back regardless so
    // typing continues where the caret was.
    view.focus();
  };

  return (
    <div className="editor-format-toolbar" role="toolbar" aria-label="Formatting">
      {GROUPS.map((group, i) => (
        // Groups are a fixed, ordered list — the index is the identity.
        <div className="editor-format-group" key={i}>
          {group.map((item) => {
            const on = item.mark != null && isActive(marks, item.mark);
            const hint = item.key ? `${item.label}  ${shortcut(item.key)}` : item.label;
            return (
              <button
                key={item.label}
                type="button"
                className="editor-format-btn"
                title={hint}
                aria-label={hint}
                aria-pressed={item.mark != null ? on : undefined}
                disabled={disabled}
                // Keep the editor's selection: a focus change would collapse it
                // before the command ever runs.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fire(item.run)}
              >
                {item.icon}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
