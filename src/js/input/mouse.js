const BUTTONS = { 0: 'left', 1: 'middle', 2: 'right' };
const WHEEL_TICK = 120;
const WHEEL_UNIT = { 0: 100, 1: 16, 2: 400 };
const MOVE_EPSILON = 0.0008;

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export class MouseController {
  #canvas;
  #getContext;
  #attached = false;
  #frame = 0;
  #pendingMove = null;
  #lastSent = null;
  #dragging = false;
  #wheelAccum = { v: 0, h: 0 };

  constructor(canvas, { getContext }) {
    this.#canvas = canvas;
    this.#getContext = getContext;
  }

  attach() {
    if (this.#attached) return;
    this.#attached = true;
    this.#canvas.addEventListener('mousemove', this.#onMove);
    this.#canvas.addEventListener('mousedown', this.#onDown);
    this.#canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#canvas.addEventListener('contextmenu', this.#onContextMenu);
    this.#canvas.addEventListener('dragstart', this.#preventDefault);
    window.addEventListener('mouseup', this.#onUp);
    window.addEventListener('blur', this.#onBlur);
  }

  detach() {
    if (!this.#attached) return;
    this.#attached = false;
    this.#canvas.removeEventListener('mousemove', this.#onMove);
    this.#canvas.removeEventListener('mousedown', this.#onDown);
    this.#canvas.removeEventListener('wheel', this.#onWheel);
    this.#canvas.removeEventListener('contextmenu', this.#onContextMenu);
    this.#canvas.removeEventListener('dragstart', this.#preventDefault);
    window.removeEventListener('mouseup', this.#onUp);
    window.removeEventListener('blur', this.#onBlur);
    if (this.#frame) cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#dragging = false;
    this.#canvas.classList.remove('is-pressed');
  }

  #onBlur = () => {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#canvas.classList.remove('is-pressed');
    this.#input({ type: 'up', button: 'left' });
  };

  #point(event) {
    const rect = this.#canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  }

  #input(payload) {
    const context = this.#getContext?.();
    if (!context?.enabled || context.monitor === null || context.monitor === undefined) return;
    context.send({ ...payload, monitor: context.monitor });
  }

  #onMove = (event) => {
    // Solo enviamos eventos de movimiento cuando hay un botón presionado (arrastre).
    // Enviar 'move' en hover continuo satura la red con cientos de HTTP POSTs por segundo
    // y genera un bucle de retroalimentación infinito (feedback loop) destructivo
    // cuando el cliente se conecta a la misma máquina (localhost), haciendo que el cursor se mueva solo.
    if (!this.#dragging) return;

    const point = this.#point(event);
    if (!point) return;
    this.#pendingMove = point;
    if (!this.#frame) this.#frame = requestAnimationFrame(this.#flushMove);
  };

  #flushMove = () => {
    this.#frame = 0;
    const point = this.#pendingMove;
    this.#pendingMove = null;
    if (!point) return;
    const last = this.#lastSent;
    if (last && Math.abs(last.x - point.x) < MOVE_EPSILON && Math.abs(last.y - point.y) < MOVE_EPSILON) return;
    this.#lastSent = point;
    this.#input({ type: 'move', ...point });
  };

  #onDown = (event) => {
    const button = BUTTONS[event.button];
    if (!button) return;
    const point = this.#point(event);
    if (!point) return;
    event.preventDefault();
    this.#dragging = true;
    this.#lastSent = null;
    this.#canvas.classList.add('is-pressed');
    this.#input({ type: 'down', button, ...point });
  };

  #onUp = (event) => {
    if (!this.#dragging) return;
    const button = BUTTONS[event.button] || 'left';
    this.#dragging = false;
    this.#canvas.classList.remove('is-pressed');
    const point = this.#point(event) || this.#lastSent;
    if (!point) return;
    this.#input({ type: 'up', button, ...point });
  };

  #onWheel = (event) => {
    const context = this.#getContext?.();
    if (!context?.enabled) return;
    event.preventDefault();

    const unit = WHEEL_UNIT[event.deltaMode] ?? 100;
    if (event.deltaY) this.#emitScroll('v', event.deltaY, unit);
    if (event.deltaX) this.#emitScroll('h', event.deltaX, unit);
  };

  #emitScroll(axis, delta, unit) {
    this.#wheelAccum[axis] += delta;
    const ticks = Math.trunc(this.#wheelAccum[axis] / unit);
    if (ticks === 0) return;
    this.#wheelAccum[axis] -= ticks * unit;
    this.#input({ type: 'scroll', delta: -ticks * WHEEL_TICK, axis });
  }

  #onContextMenu = (event) => {
    event.preventDefault();
  };

  #preventDefault = (event) => {
    event.preventDefault();
  };
}
