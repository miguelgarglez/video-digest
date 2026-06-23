import type { KeyEvent, PasteEvent, TextRenderable } from "@opentui/core";

export type SecretEditor = Readonly<{
  attach(renderable: TextRenderable): void;
  clear(): void;
  handleKey(key: KeyEvent, submit: (value: string) => void): void;
  handlePaste(event: PasteEvent): void;
  readonly mask: string;
}>;

export function createSecretEditor(): SecretEditor {
  const MAX_SECRET_LENGTH = 512;
  let characters: string[] = [];
  let cursor = 0;
  let anchor: number | null = null;
  let renderable: TextRenderable | null = null;

  const updateMask = (): void => {
    if (renderable && !renderable.isDestroyed) renderable.content = "•".repeat(characters.length);
  };
  const selection = (): [number, number] | null => anchor === null || anchor === cursor
    ? null
    : [Math.min(anchor, cursor), Math.max(anchor, cursor)];
  const deleteSelection = (): boolean => {
    const range = selection();
    if (!range) return false;
    characters.splice(range[0], range[1] - range[0]);
    cursor = range[0];
    anchor = null;
    return true;
  };
  const move = (next: number, shift: boolean): void => {
    if (shift) anchor ??= cursor;
    else anchor = null;
    cursor = Math.max(0, Math.min(characters.length, next));
  };
  const insert = (value: string): void => {
    const incoming = Array.from(value).slice(0, MAX_SECRET_LENGTH);
    if (incoming.length === 0) return;
    deleteSelection();
    const available = MAX_SECRET_LENGTH - characters.length;
    const accepted = incoming.slice(0, available);
    characters.splice(cursor, 0, ...accepted);
    cursor += accepted.length;
    anchor = null;
    updateMask();
  };
  const clear = (): void => {
    characters.fill("");
    characters = [];
    cursor = 0;
    anchor = null;
    updateMask();
    renderable = null;
  };
  const handleKey = (key: KeyEvent, submit: (value: string) => void): void => {
    const name = key.name.toLowerCase();
    let handled = true;
    if ((name === "return" || name === "enter" || name === "linefeed" || name === "kpenter") && !key.shift) {
      const value = characters.join("");
      clear();
      submit(value);
    } else if (name === "left") {
      const range = selection();
      move(!key.shift && range ? range[0] : cursor - 1, key.shift);
    } else if (name === "right") {
      const range = selection();
      move(!key.shift && range ? range[1] : cursor + 1, key.shift);
    } else if (name === "home") {
      move(0, key.shift);
    } else if (name === "end") {
      move(characters.length, key.shift);
    } else if (name === "backspace") {
      if (!deleteSelection() && cursor > 0) characters.splice(--cursor, 1);
      updateMask();
    } else if (name === "delete") {
      if (!deleteSelection() && cursor < characters.length) characters.splice(cursor, 1);
      updateMask();
    } else if ((key.ctrl || key.meta) && name === "a") {
      anchor = 0;
      cursor = characters.length;
    } else if (!key.ctrl && !key.meta) {
      const text = printableKeyText(key);
      if (text) insert(text);
      else handled = false;
    } else {
      handled = false;
    }
    if (handled) {
      key.preventDefault();
      key.stopPropagation();
    }
  };
  const handlePaste = (event: PasteEvent): void => {
    const value = new TextDecoder().decode(event.bytes).replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
    insert(value);
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    attach(next) {
      renderable = next;
      updateMask();
    },
    clear,
    handleKey,
    handlePaste,
    get mask() { return "•".repeat(characters.length); },
  };
}

function printableKeyText(key: KeyEvent): string {
  const value = key.sequence || key.raw;
  return value && !/[\u0000-\u001F\u007F-\u009F]/u.test(value) ? value : "";
}
