import { bus, Events } from '../core/events.js';

const VK = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Shift: 0x10,
  Control: 0x11,
  Alt: 0x12,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  ' ': 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  Meta: 0x5b,
  ContextMenu: 0x5d,
  NumLock: 0x90,
  ScrollLock: 0x91,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde,
};

const MODIFIER_VKS = new Set([0x10, 0x11, 0x12, 0x5b, 0x5c]);
const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditable(target) {
  return Boolean(target) && (EDITABLE.has(target.tagName) || target.isContentEditable);
}

function virtualKey(event) {
  const code = event.code || '';

  if (code === 'MetaLeft') return 0x5b;
  if (code === 'MetaRight') return 0x5c;
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 0x10;
  if (code === 'ControlLeft' || code === 'ControlRight') return 0x11;
  if (code === 'AltLeft' || code === 'AltRight') return 0x12;

  let match = /^Key([A-Z])$/.exec(code);
  if (match) return match[1].charCodeAt(0);

  match = /^Digit([0-9])$/.exec(code);
  if (match) return 0x30 + Number(match[1]);

  match = /^Numpad([0-9])$/.exec(code);
  if (match) return 0x60 + Number(match[1]);

  match = /^F([0-9]{1,2})$/.exec(code);
  if (match) return 0x70 + Number(match[1]) - 1;

  if (code === 'NumpadEnter') return 0x0d;
  if (code === 'NumpadAdd') return 0x6b;
  if (code === 'NumpadSubtract') return 0x6d;
  if (code === 'NumpadMultiply') return 0x6a;
  if (code === 'NumpadDivide') return 0x6f;
  if (code === 'NumpadDecimal') return 0x6e;
  if (code === 'Backquote') return 0xc0;
  if (code === 'Minus') return 0xbd;
  if (code === 'Equal') return 0xbb;
  if (code === 'BracketLeft') return 0xdb;
  if (code === 'BracketRight') return 0xdd;
  if (code === 'Backslash') return 0xdc;
  if (code === 'Semicolon') return 0xba;
  if (code === 'Quote') return 0xde;
  if (code === 'Comma') return 0xbc;
  if (code === 'Period') return 0xbe;
  if (code === 'Slash') return 0xbf;

  if (Object.hasOwn(VK, event.key)) return VK[event.key];

  return null;
}

export class KeyboardController {
  #getContext;
  #clipboard;
  #attached = false;
  #heldModifiers = new Set();
  #metaComboUsed = false;

  constructor({ getContext, clipboard = null }) {
    this.#getContext = getContext;
    this.#clipboard = clipboard;
  }

  attach() {
    if (this.#attached) return;
    this.#attached = true;
    window.addEventListener('keydown', this.#onKeyDown, { capture: true });
    window.addEventListener('keyup', this.#onKeyUp, { capture: true });
    window.addEventListener('blur', this.#releaseAllModifiers);
    document.addEventListener('visibilitychange', this.#onVisibilityChange);
  }

  detach() {
    if (!this.#attached) return;
    this.#attached = false;
    this.#releaseAllModifiers();
    window.removeEventListener('keydown', this.#onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.#onKeyUp, { capture: true });
    window.removeEventListener('blur', this.#releaseAllModifiers);
    document.removeEventListener('visibilitychange', this.#onVisibilityChange);
  }

  lockSystemKeyboard() {
    try {
      navigator.keyboard?.lock?.();
    } catch {
      /* disponible en Chromium/Electron fullscreen */
    }
  }

  unlockSystemKeyboard() {
    try {
      navigator.keyboard?.unlock?.();
    } catch {
      /* ignore */
    }
  }

  #onVisibilityChange = () => {
    if (document.hidden) this.#releaseAllModifiers();
  };

  #releaseAllModifiers = () => {
    const context = this.#getContext?.();
    if (context?.enabled) {
      for (const vk of this.#heldModifiers) {
        context.send({ type: 'keyup', code: vk });
      }
    }
    this.#heldModifiers.clear();
  };

  #ensureModifiersHeld(event, context) {
    const required = [];
    if (event.ctrlKey) required.push(0x11);
    if (event.shiftKey) required.push(0x10);
    if (event.altKey) required.push(0x12);
    if (event.metaKey) required.push(0x5b);

    for (const vk of required) {
      if (!this.#heldModifiers.has(vk)) {
        this.#heldModifiers.add(vk);
        context.send({ type: 'keydown', code: vk });
      }
    }
  }

  #onKeyDown = (event) => {
    if (isEditable(event.target)) return;

    // Atajos propios del cliente Remote PC: Ctrl + Alt + [1..9 | M | R] y F11
    if (event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) {
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code || '');
      if (match) {
        event.preventDefault();
        bus.emit(Events.MonitorSelectIndex, Number(match[1]));
        return;
      }

      if (event.code === 'KeyM') {
        event.preventDefault();
        bus.emit(Events.ToggleTopbar);
        return;
      }

      if (event.code === 'KeyR') {
        event.preventDefault();
        bus.emit(Events.RefreshStream);
        return;
      }
    }

    if (event.key === 'F11') {
      event.preventDefault();
      bus.emit(Events.ToggleFullscreen);
      return;
    }

    const context = this.#getContext?.();
    if (!context?.enabled) return;

    // Si el menú flotante está abierto y se presiona Escape sin modificadores, cerrarlo
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) {
      if (context.isTopbarVisible?.()) {
        event.preventDefault();
        bus.emit(Events.Escape);
        return;
      }
    }

    event.preventDefault();
    event.stopPropagation();

    const vk = virtualKey(event);

    // Si es una tecla modificadora pura (Shift, Ctrl, Alt, Windows/Meta)
    if (vk !== null && MODIFIER_VKS.has(vk)) {
      if (vk === 0x5b || vk === 0x5c) {
        this.#metaComboUsed = false;
      }
      if (!this.#heldModifiers.has(vk)) {
        this.#heldModifiers.add(vk);
        context.send({ type: 'keydown', code: vk });
      }
      return;
    }

    if (event.metaKey || this.#heldModifiers.has(0x5b) || this.#heldModifiers.has(0x5c)) {
      this.#metaComboUsed = true;
    }

    // Sincronización de portapapeles en Ctrl+V / Ctrl+C / Ctrl+X
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.code === 'KeyV' && this.#clipboard) {
        void this.#clipboard.handlePasteShortcut(async () => {
          this.#ensureModifiersHeld(event, context);
          context.send({ type: 'keyvk', code: 0x56 });
        });
        return;
      }

      if ((event.code === 'KeyC' || event.code === 'KeyX') && this.#clipboard) {
        this.#ensureModifiersHeld(event, context);
        context.send({ type: 'keyvk', code: event.code === 'KeyC' ? 0x43 : 0x58 });
        this.#clipboard.schedulePullFromRemote(160);
        return;
      }
    }

    const withModifier = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;

    if (withModifier && vk !== null) {
      this.#ensureModifiersHeld(event, context);
      context.send({ type: 'keyvk', code: vk });
      return;
    }

    if (event.key && event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      context.send({ type: 'keychar', code: event.key.charCodeAt(0) });
      return;
    }

    if (vk !== null) {
      context.send({ type: 'keyvk', code: vk });
    }
  };

  #onKeyUp = (event) => {
    if (isEditable(event.target)) return;

    const context = this.#getContext?.();
    const vk = virtualKey(event);

    if (vk !== null && MODIFIER_VKS.has(vk)) {
      event.preventDefault();
      event.stopPropagation();

      if (this.#heldModifiers.has(vk)) {
        this.#heldModifiers.delete(vk);
        if (context?.enabled) {
          context.send({ type: 'keyup', code: vk });
        }
      } else if ((vk === 0x5b || vk === 0x5c) && !this.#metaComboUsed && context?.enabled) {
        // Toque solitario del botón Windows abre el menú Inicio remoto
        context.send({ type: 'keyvk', code: vk });
      }
    }
  };
}
