"use strict";

const {
	Plugin,
	PluginSettingTab,
	Setting,
	Notice,
	setIcon,
	editorInfoField,
	debounce,
} = require("obsidian");
const { Decoration, WidgetType, EditorView, keymap } = require("@codemirror/view");
const { StateEffect, StateField, Prec } = require("@codemirror/state");
const { history, defaultKeymap, historyKeymap } = require("@codemirror/commands");

const MAX_DEPTH = 5;

const DEFAULT_SETTINGS = {
	nestStyle: "line", // "line" | "card" | "card-line"
};

/* ------------------------------------------------------------------ */
/* State. Expansion defaults depend on depth (top level: expanded,     */
/* nested: collapsed), so the field stores which links the user has    */
/* TOGGLED away from their default, not which are open.                */
/* ------------------------------------------------------------------ */

const toggleInline = StateEffect.define();
// no-op effect used purely to force a decoration rebuild (e.g. after
// a note file was just created outside of a doc change)
const refreshInline = StateEffect.define();

const toggledField = StateField.define({
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

/* nested editors reveal [[brackets]] only while focused with the
 * cursor inside the link — so we track focus as editor state */
const setFocused = StateEffect.define();

const focusedField = StateField.define({
	create() {
		return false;
	},
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setFocused)) value = e.value;
		}
		return value;
	},
});

function isOpen(state, linkText, depth) {
	const defaultOpen = depth === 0;
	const toggled = state.field(toggledField).has(linkText);
	return defaultOpen !== toggled;
}

function linkAt(state, pos, requireAtEnd) {
	const line = state.doc.lineAt(pos);
	LINK_RE.lastIndex = 0;
	let m;
	while ((m = LINK_RE.exec(line.text)) !== null) {
		const start = line.from + m.index;
		const end = start + m[0].length;
		const hit = requireAtEnd ? pos === end : pos >= start && pos <= end;
		if (hit && m[1].trim()) return m[1].trim();
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* Link toggle widget: chevron once the note exists (always visible),  */
/* file-plus while it doesn't (shows on line hover).                   */
/* ------------------------------------------------------------------ */

class LinkToggleWidget extends WidgetType {
	constructor(plugin, linkText, sourcePath, depth, exists, open, canInline) {
		super();
		this.plugin = plugin;
		this.linkText = linkText;
		this.sourcePath = sourcePath;
		this.depth = depth;
		this.exists = exists;
		this.open = open;
		this.canInline = canInline;
	}

	eq(other) {
		return (
			other.linkText === this.linkText &&
			other.exists === this.exists &&
			other.open === this.open &&
			other.canInline === this.canInline
		);
	}

	toDOM(view) {
		const btn = document.createElement("span");
		btn.className = "inline-note-btn";
		if (this.exists) btn.classList.add("is-visible");
		if (!this.exists) {
			btn.setAttribute("aria-label", "Create inline (Tab after ]])");
			setIcon(btn, "file-plus-2");
		} else if (!this.canInline) {
			btn.setAttribute("aria-label", "Open note");
			setIcon(btn, "lucide-external-link");
		} else {
			btn.setAttribute("aria-label", this.open ? "Collapse (Tab after ]])" : "Expand (Tab after ]])");
			setIcon(btn, this.open ? "chevron-down" : "chevron-right");
		}
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
		});
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (this.exists && !this.canInline) {
				this.plugin.app.workspace.openLinkText(this.linkText, this.sourcePath, false);
				return;
			}
			this.plugin.toggleInlineNote(view, this.linkText, this.sourcePath, this.depth);
		});
		return btn;
	}

	ignoreEvent() {
		return true;
	}
}

/* ------------------------------------------------------------------ */
/* Inline body: no card chrome — the link is the title.                */
/* ------------------------------------------------------------------ */

class InlineNoteWidget extends WidgetType {
	constructor(plugin, linkText, sourcePath, depth, ancestors) {
		super();
		this.plugin = plugin;
		this.linkText = linkText;
		this.sourcePath = sourcePath;
		this.depth = depth;
		this.ancestors = ancestors;
	}

	eq(other) {
		return other.linkText === this.linkText && other.sourcePath === this.sourcePath;
	}

	toDOM() {
		const panel = buildInlineBody(
			this.plugin,
			this.linkText,
			this.sourcePath,
			this.depth,
			this.ancestors
		);
		this._destroyPanel = panel.destroy;
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

function buildInlineBody(plugin, linkText, sourcePath, depth, ancestors) {
	const app = plugin.app;

	const wrap = document.createElement("div");
	wrap.className = "inline-note-flow";

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

	const loadContent = (attempt) => {
		const file = plugin.resolveLink(linkText, sourcePath);
		if (file) {
			const childSourcePath = file.path;
			const childAncestors = ancestors.concat([file.path]);
			app.vault.read(file).then((content) => {
				editor = new EditorView({
					doc: content,
					parent: wrap,
					extensions: [
						history(),
						keymap.of([...historyKeymap, ...defaultKeymap]),
						EditorView.lineWrapping,
						focusedField,
						EditorView.updateListener.of((u) => {
							if (u.docChanged) {
								dirty = true;
								debouncedSave();
							}
							if (u.focusChanged) {
								const focused = u.view.hasFocus;
								queueMicrotask(() =>
									u.view.dispatch({ effects: setFocused.of(focused) })
								);
							}
						}),
						// links with hidden brackets act like native links:
						// click opens the note, Cmd/Ctrl+click opens a new tab
						EditorView.domEventHandlers({
							mousedown: (e, view) => {
								const el =
									e.target instanceof Element &&
									e.target.closest(".inline-note-link-clickable");
								if (!el) return false;
								const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
								if (pos == null) return false;
								const target = linkAt(view.state, pos, false);
								if (!target) return false;
								e.preventDefault();
								app.workspace.openLinkText(
									target,
									childSourcePath,
									e.metaKey || e.ctrlKey
								);
								return true;
							},
						}),
						buildInlineExtensions(
							plugin,
							() => childSourcePath,
							depth,
							() => childAncestors
						),
						EditorView.contentAttributes.of({ "aria-label": linkText }),
					],
				});
				editor.dom.classList.add("inline-note-editor");
				editor.contentDOM.addEventListener("blur", () => saveSelf());
				if (plugin.consumePendingFocus(linkText)) editor.focus();
			});
		} else if (attempt < 10) {
			window.setTimeout(() => loadContent(attempt + 1), 100);
		} else {
			const err = wrap.appendChild(document.createElement("div"));
			err.className = "inline-note-error";
			err.textContent = "Note not found: " + linkText;
		}
	};
	loadContent(0);

	return {
		el: wrap,
		destroy: () => {
			saveSelf();
			if (editor) editor.destroy();
		},
	};
}

/* ------------------------------------------------------------------ */
/* Shared editor extensions (main editor and every nested editor)      */
/* ------------------------------------------------------------------ */

function buildDecorationField(plugin, getSourcePath, depth, getAncestors) {
	const linkEditingMark = Decoration.mark({ class: "inline-note-link" });
	const linkClickableMark = Decoration.mark({
		class: "inline-note-link inline-note-link-clickable",
	});
	const hideMark = Decoration.replace({});

	const selectionTouches = (state, from, to) => {
		for (const r of state.selection.ranges) {
			if (r.to >= from && r.from <= to) return true;
		}
		return false;
	};

	const buildDecos = (state) => {
		const decos = [];
		const sourcePath = getSourcePath(state);
		const ancestors = getAncestors(state);
		const rendered = new Set();

		const text = state.doc.toString();
		LINK_RE.lastIndex = 0;
		let m;
		while ((m = LINK_RE.exec(text)) !== null) {
			const linkText = m[1].trim();
			if (!linkText) continue;
			const start = m.index;
			const end = start + m[0].length;

			// inside nested editors there's no Obsidian markdown mode, so
			// style [[links]] ourselves — like live preview, the brackets
			// are hidden unless the cursor is inside the link
			if (depth > 0) {
				const revealed =
					state.field(focusedField, false) && selectionTouches(state, start, end);
				if (revealed) {
					decos.push(linkEditingMark.range(start, end));
				} else {
					decos.push(hideMark.range(start, start + 2));
					decos.push(linkClickableMark.range(start + 2, end - 2));
					decos.push(hideMark.range(end - 2, end));
				}
			}

			const file = plugin.resolveLink(linkText, sourcePath);
			const exists = !!file;
			// no inline body for links that would recurse into an ancestor
			// (self-links, A→B→A loops) or past the depth cap
			const canInline = exists && depth < MAX_DEPTH && !ancestors.includes(file.path);
			const open = canInline && isOpen(state, linkText, depth) && !rendered.has(linkText);

			decos.push(
				Decoration.widget({
					widget: new LinkToggleWidget(plugin, linkText, sourcePath, depth, exists, open, canInline),
					side: 1,
				}).range(end)
			);

			if (open) {
				rendered.add(linkText);
				const line = state.doc.lineAt(end);
				decos.push(
					Decoration.widget({
						widget: new InlineNoteWidget(plugin, linkText, sourcePath, depth + 1, ancestors),
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
			if (
				tr.docChanged ||
				// nested editors reveal/hide brackets as the cursor moves
				// or the editor gains/loses focus
				(depth > 0 && tr.selection) ||
				tr.effects.some((e) => e.is(setFocused)) ||
				tr.effects.some((e) => e.is(toggleInline) || e.is(refreshInline))
			) {
				return buildDecos(tr.state);
			}
			return value;
		},
		provide: (field) => EditorView.decorations.from(field),
	});
}

function buildToggleKeymap(plugin, getSourcePath, depth) {
	return Prec.high(
		keymap.of([
			{
				// Tab immediately after "]]": cycle the inline note —
				// create+expand if missing, expand if collapsed, collapse
				// if open. Never fires elsewhere, so indentation is safe.
				key: "Tab",
				run: (view) => {
					const linkText = linkAt(view.state, view.state.selection.main.head, true);
					if (!linkText) return false;
					plugin.toggleInlineNote(view, linkText, getSourcePath(view.state), depth);
					return true;
				},
			},
		])
	);
}

function buildInlineExtensions(plugin, getSourcePath, depth, getAncestors) {
	return [
		toggledField,
		buildDecorationField(plugin, getSourcePath, depth, getAncestors),
		buildToggleKeymap(plugin, getSourcePath, depth),
	];
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

class InlineNoteSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Nesting style")
			.setDesc("How inline note bodies are rendered.")
			.addDropdown((dd) =>
				dd
					.addOption("line", "Vertical accent line")
					.addOption("card", "Card (background only)")
					.addOption("card-line", "Card + vertical accent line")
					.setValue(this.plugin.settings.nestStyle)
					.onChange(async (value) => {
						this.plugin.settings.nestStyle = value;
						this.plugin.applyNestStyle();
						await this.plugin.saveSettings();
					})
			);
	}
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class InlineNotePlugin extends Plugin {
	async onload() {
		this._pendingFocus = null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.applyNestStyle();
		this.addSettingTab(new InlineNoteSettingTab(this.app, this));

		const getRootSourcePath = (state) => {
			const info = state.field(editorInfoField, false);
			return (info && info.file && info.file.path) || "";
		};
		const getRootAncestors = (state) => {
			const p = getRootSourcePath(state);
			return p ? [p] : [];
		};
		this.registerEditorExtension(
			buildInlineExtensions(this, getRootSourcePath, 0, getRootAncestors)
		);

		this.addCommand({
			id: "toggle-inline-note-at-cursor",
			name: "Toggle inline note for link under cursor",
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
				if (editor.cm) this.toggleInlineNote(editor.cm, target, sourcePath, 0);
			},
		});
	}

	onunload() {
		document.body.classList.remove(
			"inline-note-style-line",
			"inline-note-style-card",
			"inline-note-style-card-line"
		);
	}

	applyNestStyle() {
		document.body.classList.remove(
			"inline-note-style-line",
			"inline-note-style-card",
			"inline-note-style-card-line"
		);
		document.body.classList.add("inline-note-style-" + this.settings.nestStyle);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	consumePendingFocus(linkText) {
		if (this._pendingFocus === linkText) {
			this._pendingFocus = null;
			return true;
		}
		return false;
	}

	/** Create the note if needed, then toggle its inline body in `view`. */
	toggleInlineNote(view, linkText, sourcePath, depth) {
		if (depth >= MAX_DEPTH) {
			new Notice("Inline Note: max nesting depth reached — opening in a tab.");
			this.app.workspace.openLinkText(linkText, sourcePath, false);
			return;
		}
		const existedBefore = !!this.resolveLink(linkText, sourcePath);
		this.ensureFile(linkText, sourcePath)
			.then(() => {
				const openNow = isOpen(view.state, linkText, depth);
				const wantOpen = existedBefore ? !openNow : true;
				if (wantOpen) this._pendingFocus = linkText;
				view.dispatch({
					effects:
						wantOpen === openNow
							? refreshInline.of(linkText)
							: toggleInline.of(linkText),
				});
				// Collapsing destroys the nested editor; if it held keyboard
				// focus, focus would silently fall to <body>, which other
				// plugins (e.g. graph preview panes watching focusin/focusout)
				// read as "the user left the pane". Hand focus to the editor
				// that owns the link instead.
				if (!wantOpen) view.focus();
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
