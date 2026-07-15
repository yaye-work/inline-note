# Inline Note

Write inside your links without leaving the page.

When you create a `[[wikilink]]` in Obsidian, you often want to jot something
down for that new topic *right now* — but clicking through opens a blank note
and you lose the context you were writing in. Inline Note lets you expand any
link into an editable note body **inline**, directly beneath the link, without
navigating away. The link itself becomes a collapsible title.

Every inline note is a **real Markdown file** in your vault, so backlinks, graph
view, and normal note-opening all behave exactly as usual. You're just editing
it from where you are.

## How it works

- **Toggle button on every link.** In Live Preview, each `[[link]]` gets a small
  control after it:
  - a **＋** icon (revealed on line hover) when the note doesn't exist yet —
    click to create it and start writing inline;
  - a **chevron** (always visible) once the note exists — click to expand or
    collapse its inline body.
- **Keyboard-first.** With the cursor right after the closing `]]`, press
  **Tab** to cycle the inline note: create + expand, expand, or collapse. Tab
  only acts there, so normal indentation is untouched everywhere else.
- **Nesting.** Inline bodies are full editors, so a `[[link]]` typed *inside* an
  inline note behaves identically — expand it and you get a note within a note,
  up to five levels deep. Links inside inline bodies render live-preview style
  (brackets hidden until you edit) and open on click / new tab on Ctrl/Cmd-click.
- **Real notes.** Nothing here is virtual. Watch your graph fill in live as you
  write nested notes.

## Settings

**Nesting style** — how inline bodies are drawn:

1. **Vertical accent line** — indented under a thin accent bar (default).
2. **Card** — a subtle rounded background per level.
3. **Card + vertical accent line** — both.

## Installation (manual)

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest
   release.
2. Copy them into `<your vault>/.obsidian/plugins/inline-note/`.
3. Reload Obsidian and enable **Inline Note** under
   Settings → Community plugins.

## License

[MIT](LICENSE) © yaye.work
