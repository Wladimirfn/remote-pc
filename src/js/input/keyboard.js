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

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditable(target) {
  return Boolean(target) && (EDITABLE.has(target.tagName) || target.isContentEditable);
}

function virtualKey(event) {
  const code = event.code || '';

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

  if (Object.hasOwn(VK, event.key)) return VK[event.key];

  return null;
}

function payloadFor(event) {
  const { key } = event;
  const withModifier = event.ctrlKey || event.altKey || event.metaKey;

  if (key.length === 1) {
    if (withModifier) {
      const vk = virtualKey(event);
      if (vk !== null) return { type: 'keyvk', code: vk };
    }
    return { type: 'keychar', code: key.charCodeAt(0) };
  }

  const vk = virtualKey(event);
  return vk === null ? null : { type: 'keyvk', code: vk };
}

export class KeyboardController {
  #getContext;
  #attached = false;

  constructor({ getContext }) {
    this.#getContext = getContext;
  }

  attach() {
    if (this.#attached) return;
    this.#attached = true;
    window.addEventListener('keydown', this.#onKeyDown);
  }

  detach() {
    if (!this.#attached) return;
    this.#attached = false;
    window.removeEventListener('keydown', this.#onKeyDown);
  }

  #onKeyDown = (event) => {
    if (isEditable(event.target)) return;

    if (event.ctrlKey && event.altKey && !event.metaKey) {
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code || '');
      if (match) {
        event.preventDefault();
        bus.emit(Events.MonitorSelectIndex, Number(match[1]));
        return;
      }
    }

    if (event.key === 'F11') {
      event.preventDefault();
      bus.emit(Events.ToggleFullscreen);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      bus.emit(Events.Escape);
      return;
    }

    const context = this.#getContext?.();
    if (!context?.enabled) return;

    const payload = payloadFor(event);
    if (!payload) return;

    event.preventDefault();
    context.send(payload);
  };
}
