export class EventBus {
  #channels = new Map();

  on(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('El handler debe ser una función');
    let handlers = this.#channels.get(type);
    if (!handlers) {
      handlers = new Set();
      this.#channels.set(type, handlers);
    }
    handlers.add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    const handlers = this.#channels.get(type);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.#channels.delete(type);
  }

  emit(type, payload) {
    const handlers = this.#channels.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[bus] fallo en el canal "${type}"`, error);
      }
    }
  }
}

export const bus = new EventBus();

export const Events = Object.freeze({
  MonitorSelect: 'stream:monitor-select',
  MonitorSelectIndex: 'stream:monitor-select-index',
  QualityChange: 'stream:quality-change',
  ToggleFullscreen: 'ui:toggle-fullscreen',
  ToggleTopbar: 'ui:toggle-topbar',
  Escape: 'ui:escape',
  Disconnect: 'app:disconnect',
});
