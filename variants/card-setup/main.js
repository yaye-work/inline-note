"use strict";

const { Plugin, Notice, setIcon, editorInfoField, debounce } = require("obsidian");
const { Decoration, WidgetType, EditorView, keymap } = require("@codemirror/view");
const { StateEffect, StateField, Prec } = require("@codemirror/state");
const { history, defaultKeymap, historyKeymap } = require("@codemirror/commands");

const MAX_DEPTH = 5;

/* ------------------------------------------------------------------ */
/* State: which link targets are currently expanded (per editor view)  */
/* ------------------------------------------------------------------ */

const toggleInline = StateEffect.define();

const expandedField = StateField.define({
	create() {
		return new Set();
	},
	update(value, tr) {
		let next = value;
		for (const e of tr.effects) {
			if (e.is(toggleInline)) {
				if (next === value) next = new Set(value);
				if (next.has(e.value)) next.delete(e.value);
				else next.add(e.value);
			}
		}
		return next;
	},
});

const LINK_RE = /\[\[([^\[\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g;

/* ------------------------------------------------------------------ */
/* Widgets                                                             */
/* ------------------------------------------------------------------ */

class EditButtonWidget extends WidgetType {
	constructor(plugin, linkText, sourcePath, exists, depth) {
		super();
		this.plugin = plugin;
		this.linkText = linkText;
		this.sourcePath = sourcePath;
		this.exists = exists;
		this.depth = depth;
	}

	eq(other) {
		return other.linkText === this.linkText && other.exists === this.exists;
	}

	toDOM(view) {
		const btn = document.createElement("span");
		btn.className = "inline-note-btn";
		btn.setAttribute("aria-label", this.exists ? "Edit inline (Tab after ]])" : "Create & edit inline (Tab after ]])");
		setIcon(btn, this.exists ? "pencil-line" : "file-plus-2");
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.plugin.openInline(view, this.linkText, this.sourcePath, this.depth);
		});
		return btn;
	}

	ignoreEvent() {
		return true;
	}
}

class InlineNoteWidget extends WidgetType {
	constructor(plugin, linkText, sourcePath, depth) {
		super();
		this.plugin = plugin;
		this.linkText = linkText;
		this.sourcePath = sourcePath;
		this.depth = depth;
	}

	eq(other) {
		return other.linkText === this.linkText && other.sourcePath === this.sourcePath;
	}

	toDOM(view) {
		const panel = buildPanel(this.plugin, this.linkText, this.sourcePath, this.depth, view);
		this._flush = panel.flush;
		this._destroyPanel = panel.destroy;
		// keep the outer editor from hijacking clicks inside the widget
		panel.el.addEventListener("mousedown", (e) => e.stopPropagation());
		return panel.el;
	}

	destroy() {
		if (this._destroyPanel) this._destroyPanel();
	}

	ignoreEvent() {
		return true;
	}
}

/* ------------------------------------------------------------------ */
/* Shared editor extensions: link buttons + expandable panels.         */
/* Used by the main Obsidian editor (depth 0) and every nested         */
/* editor, so [[links]] behave identically at every level.             */
/* ------------------------------------------------------------------ */

function buildDecorationField(plugin, getSourcePath, depth) {
	const buildDecos = (state) => {
		const decos = [];
		const expanded = state.field(expandedField);
		const sourcePath = getSourcePath(state);
		const rendered = new Set();

		const text = state.doc.toString();
		LINK_RE.lastIndex = 0;
		let m;
		while ((m = LINK_RE.exec(text)) !== null) {
			const linkText = m[1].trim();
			if (!linkText) continue;
			const end = m.index + m[0].length;

			const exists = !!plugin.resolveLink(linkText, sourcePath);
			decos.push(
				Decoration.widget({
					widget: new EditButtonWidget(plugin, linkText, sourcePath, exists, depth),
					side: 1,
				}).range(end)
			);

			if (expanded.has(linkText) && !rendered.has(linkText)) {
				rendered.add(linkText);
				const line = state.doc.lineAt(end);
				decos.push(
					Decoration.widget({
						widget: new InlineNoteWidget(plugin, linkText, sourcePath, depth + 1),
						side: 2,
						block: true,
					}).range(line.to)
				);
			}
		}
		return Decoration.set(decos, true);
	};

	return StateField.define({
		create(state) {
			return buildDecos(state);
		},
		update(value, tr) {
			if (tr.docChanged || tr.effects.some((e) => e.is(toggleInline))) {
				return buildDecos(tr.state);
			}
			return value;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildToggleKeymap(plugin, getSourcePath, depth) {
	// Tab: only when the cursor sits immediately after "]]" — never
	// interferes with indentation. Mod-Enter: anywhere inside a link.
	const tryToggle = (view, requireAtEnd) => {
		const pos = view.state.selection.main.head;
		const line = view.state.doc.lineAt(pos);
		LINK_RE.lastIndex = 0;
		let m;
		while ((m = LINK_RE.exec(line.text)) !== null) {
			const start = line.from + m.index;
			const end = start + m[0].length;
			const hit = requireAtEnd ? pos === end : pos >= start && pos <= end;
			if (hit) {
				const linkText = m[1].trim();
				if (!linkText) return false;
				plugin.openInline(view, linkText, getSourcePath(view.state), depth);
				return true;
			}
		}
		return false;
	};

	return Prec.high(
		keymap.of([
			{ key: "Tab", run: (view) => tryToggle(view, true) },
			{ key: "Mod-Enter", run: (view) => tryToggle(view, false) },
		])
	);
}

function buildInlineExtensions(plugin, getSourcePath, depth) {
	return [
		expandedField,
		buildDecorationField(plugin, getSourcePath, depth),
		buildToggleKeymap(plugin, getSourcePath, depth),
	];
}

/* ------------------------------------------------------------------ */
/* Inline panel: a card with its own CodeMirror editor. Because the    */
/* nested editor runs the same extensions, [[links]] typed inside it   */
/* get the same button / Tab behaviour — recursion falls out for free. */
/* ------------------------------------------------------------------ */

function buildPanel(plugin, linkText, sourcePath, depth, parentView) {
	const app = plugin.app;

	const closeSelf = () => {
		flush();
		parentView.dispatch({ effects: toggleInline.of(linkText) });
		parentView.focus();
	};

	const wrap = document.createElement("div");
	wrap.className = "inline-note-embed";

	const header = wrap.appendChild(document.createElement("div"));
	header.className = "inline-note-header";

	const chevron = header.appendChild(document.createElement("span"));
	chevron.className = "inline-note-chevron";
	setIcon(chevron, "chevron-down");

	const title = header.appendChild(document.createElement("span"));
	title.className = "inline-note-title";
	title.textContent = linkText;

	const openBtn = header.appendChild(document.createElement("span"));
	openBtn.className = "inline-note-action";
	openBtn.setAttribute("aria-label", "Open note");
	setIcon(openBtn, "lucide-external-link");

	const closeBtn = header.appendChild(document.createElement("span"));
	closeBtn.className = "inline-note-action";
	closeBtn.setAttribute("aria-label", "Close inline editor (Esc)");
	setIcon(closeBtn, "x");

	const body = wrap.appendChild(document.createElement("div"));
	body.className = "inline-note-body";

	let editor = null;
	let dirty = false;

	const saveSelf = async () => {
		if (!editor || !dirty) return;
		const file = plugin.resolveLink(linkText, sourcePath);
		if (!file) return;
		dirty = false;
		await app.vault.modify(file, editor.state.doc.toString());
	};
	const debouncedSave = debounce(saveSelf, 500, true);
	const flush = () => saveSelf();

	// The file may have been created a moment ago and the metadata cache
	// might not have caught up yet — retry resolution briefly.
	const loadContent = (attempt) => {
		const file = plugin.resolveLink(linkText, sourcePath);
		if (file) {
			app.vault.read(file).then((content) => {
				editor = new EditorView({
					doc: content,
					parent: body,
					extensions: [
						history(),
						keymap.of([...historyKeymap, ...defaultKeymap]),
						EditorView.lineWrapping,
						EditorView.updateListener.of((u) => {
							if (u.docChanged) {
								dirty = true;
								debouncedSave();
							}
						}),
						Prec.highest(
							keymap.of([
								{
									key: "Escape",
									run: () => {
										closeSelf();
										return true;
									},
								},
							])
						),
						buildInlineExtensions(plugin, () => sourcePath, depth),
						EditorView.contentAttributes.of({ "aria-label": linkText }),
					],
				});
				editor.dom.classList.add("inline-note-editor");
				editor.contentDOM.addEventListener("blur", () => saveSelf());
				editor.focus();
			});
		} else if (attempt < 10) {
			window.setTimeout(() => loadContent(attempt + 1), 100);
		} else {
			const err = body.appendChild(document.createElement("div"));
			err.className = "inline-note-error";
			err.textContent = "Note not found: " + linkText;
		}
	};
	loadContent(0);

	const headerToggle = () => {
		const collapsed = wrap.classList.toggle("is-collapsed");
		setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
	};
	chevron.addEventListener("click", headerToggle);
	title.addEventListener("click", headerToggle);

	openBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		flush();
		app.workspace.openLinkText(linkText, sourcePath, false);
	});

	closeBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		closeSelf();
	});

	return {
		el: wrap,
		flush,
		destroy: () => {
			flush();
			if (editor) editor.destroy();
		},
	};
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class InlineNotePlugin extends Plugin {
	async onload() {
		const getRootSourcePath = (state) => {
			const info = state.field(editorInfoField, false);
			return (info && info.file && info.file.path) || "";
		};
		this.registerEditorExtension(buildInlineExtensions(this, getRootSourcePath, 0));

		this.addCommand({
			id: "toggle-inline-note-at-cursor",
			name: "Toggle inline editor for link under cursor",
			editorCallback: async (editor, ctx) => {
				const cursor = editor.getCursor();
				const lineText = editor.getLine(cursor.line);
				LINK_RE.lastIndex = 0;
				let m;
				let target = null;
				while ((m = LINK_RE.exec(lineText)) !== null) {
					if (cursor.ch >= m.index && cursor.ch <= m.index + m[0].length) {
						target = m[1].trim();
						break;
					}
				}
				if (!target) {
					new Notice("No [[link]] under cursor.");
					return;
				}
				const sourcePath = (ctx && ctx.file && ctx.file.path) || "";
				if (editor.cm) this.openInline(editor.cm, target, sourcePath, 0);
			},
		});
	}

	/** Ensure the file exists, then toggle the inline panel in `view`. */
	openInline(view, linkText, sourcePath, depth) {
		if (depth >= MAX_DEPTH && !view.state.field(expandedField).has(linkText)) {
			new Notice("Inline Note: max nesting depth reached — opening in a tab.");
			this.app.workspace.openLinkText(linkText, sourcePath, false);
			return;
		}
		this.ensureFile(linkText, sourcePath)
			.then(() => {
				view.dispatch({ effects: toggleInline.of(linkText) });
			})
			.catch((err) => {
				new Notice("Inline Note: could not create note — " + err.message);
			});
	}

	/** Resolve a link target, falling back to a direct path lookup while
	 * the metadata cache catches up on a freshly created file. */
	resolveLink(linkText, sourcePath) {
		const viaCache = this.app.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
		if (viaCache) return viaCache;
		const folder = this.app.fileManager.getNewFileParent(sourcePath);
		const path = (folder.path === "/" ? "" : folder.path + "/") + linkText + ".md";
		const direct = this.app.vault.getFileByPath
			? this.app.vault.getFileByPath(path)
			: this.app.vault.getAbstractFileByPath(path);
		return direct || null;
	}

	/** Create the linked note (as a real file) if it doesn't exist yet. */
	async ensureFile(linkText, sourcePath) {
		const existing = this.resolveLink(linkText, sourcePath);
		if (existing) return existing;
		const folder = this.app.fileManager.getNewFileParent(sourcePath);
		const path = (folder.path === "/" ? "" : folder.path + "/") + linkText + ".md";
		return await this.app.vault.create(path, "");
	}
}

module.exports = InlineNotePlugin;
