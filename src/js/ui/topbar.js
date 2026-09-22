import { bus, Events } from '../core/events.js';
import { store } from '../core/state.js';

const QUALITIES = Object.freeze([
  { id: 'auto', label: 'Auto', title: 'Adaptativo según la red' },
  { id: 'baja', label: 'Baja', title: 'Mínimo ancho de banda' },
  { id: 'media', label: 'Media', title: 'Equilibrado' },
  { id: 'alta', label: 'Alta', title: 'Alta fidelidad' },
  { id: 'ultra', label: 'Ultra', title: 'Máxima calidad' },
]);

const HIDE_DELAY = 1400;
const HUD_INTERVAL = 220;

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

export class TopbarView {
  #root;
  #trigger;
  #els;
  #hideTimer = 0;
  #hudTimer = 0;
  #pendingState = null;
  #lastPaint = 0;
  #unsubscribe = null;

  constructor({ root, trigger }) {
    this.#root = root;
    this.#trigger = trigger;
    this.#els = {
      monitors: root.querySelector('#topbar-monitors'),
      quality: root.querySelector('#topbar-quality'),
      fps: root.querySelector('#hud-fps'),
      latency: root.querySelector('#hud-latency'),
      bytes: root.querySelector('#hud-bytes'),
      qualityValue: root.querySelector('#hud-quality'),
      fullscreen: root.querySelector('#btn-fullscreen'),
      refresh: root.querySelector('#btn-refresh'),
      hideButton: root.querySelector('#btn-hide-topbar'),
      disconnect: root.querySelector('#btn-disconnect'),
    };
  }

  get visible() {
    return this.#root.dataset.visible === 'true';
  }

  mount() {
    this.#buildQualityButtons();
    this.#trigger.addEventListener('click', () => this.toggle());
    this.#root.addEventListener('mouseenter', () => this.cancelHide());
    this.#root.addEventListener('mouseleave', () => this.scheduleHide());
    this.#root.addEventListener('pointerdown', () => this.cancelHide());
    this.#els.fullscreen.addEventListener('click', () => bus.emit(Events.ToggleFullscreen));
    this.#els.refresh.addEventListener('click', () => bus.emit(Events.RefreshStream));
    this.#els.hideButton.addEventListener('click', () => this.hide());
    this.#els.disconnect.addEventListener('click', () => bus.emit(Events.Disconnect));
    document.addEventListener('pointerdown', this.#onDocumentPointerDown);
    this.#unsubscribe = store.subscribe((state) => this.#schedulePaint(state), { immediate: true });
  }

  destroy() {
    document.removeEventListener('pointerdown', this.#onDocumentPointerDown);
    this.cancelHide();
    clearTimeout(this.#hudTimer);
    this.#unsubscribe?.();
  }

  setMonitors(monitors, activeId) {
    const container = this.#els.monitors;
    container.textContent = '';

    if (!monitors?.length) {
      const empty = document.createElement('span');
      empty.className = 'hud__item';
      empty.textContent = 'Sin monitores';
      container.append(empty);
      return;
    }

    monitors.forEach((monitor, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pill';
      button.dataset.active = String(monitor.id === activeId);
      button.textContent = `Monitor ${index + 1}${monitor.primary ? ' ★' : ''}`;
      button.title = [
        monitor.name || `Monitor ${index + 1}`,
        `${monitor.width}×${monitor.height}`,
        monitor.x || monitor.y ? `@ ${monitor.x},${monitor.y}` : null,
        `Ctrl+Alt+${index + 1}`,
      ]
        .filter(Boolean)
        .join(' · ');
      button.addEventListener('click', () => bus.emit(Events.MonitorSelect, monitor.id));
      container.append(button);
    });
  }

  setQuality(quality) {
    for (const button of this.#els.quality.querySelectorAll('.pill')) {
      button.dataset.active = String(button.dataset.quality === quality);
    }
    this.#els.qualityValue.textContent = quality;
  }

  setFullscreen(isFullscreen) {
    this.#els.fullscreen.textContent = isFullscreen ? '🗗' : '⛶';
    this.#els.fullscreen.title = isFullscreen ? 'Salir de pantalla completa (F11)' : 'Pantalla completa (F11)';
  }

  show() {
    this.cancelHide();
    if (this.visible) return;
    this.#root.dataset.visible = 'true';
    this.#trigger.setAttribute('aria-expanded', 'true');
  }

  hide() {
    this.cancelHide();
    if (!this.visible) return;
    this.#root.dataset.visible = 'false';
    this.#trigger.setAttribute('aria-expanded', 'false');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  cancelHide() {
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer);
      this.#hideTimer = 0;
    }
  }

  scheduleHide(delay = HIDE_DELAY) {
    this.cancelHide();
    this.#hideTimer = setTimeout(() => {
      this.#hideTimer = 0;
      if (this.#root.matches(':hover') || this.#trigger.matches(':hover')) {
        this.scheduleHide();
        return;
      }
      this.hide();
    }, delay);
  }

  #onDocumentPointerDown = (event) => {
    if (!this.visible) return;
    const target = event.target;
    if (this.#root.contains(target) || this.#trigger.contains(target)) return;
    this.hide();
  };

  #buildQualityButtons() {
    const container = this.#els.quality;
    container.textContent = '';
    for (const quality of QUALITIES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pill';
      button.dataset.quality = quality.id;
      button.dataset.active = String(quality.id === store.get().stream.quality);
      button.textContent = quality.label;
      button.title = quality.title;
      button.addEventListener('click', () => bus.emit(Events.QualityChange, quality.id));
      container.append(button);
    }
  }

  #schedulePaint(state) {
    this.#pendingState = state;
    if (this.#hudTimer) return;
    const delay = Math.max(0, HUD_INTERVAL - (performance.now() - this.#lastPaint));
    this.#hudTimer = setTimeout(() => {
      this.#hudTimer = 0;
      this.#lastPaint = performance.now();
      const pending = this.#pendingState;
      this.#pendingState = null;
      if (pending) this.#paint(pending);
    }, delay);
  }

  #paint(state) {
    const { metrics, stream } = state;
    this.#els.fps.textContent = String(metrics.fps);
    this.#els.latency.textContent = String(metrics.latencyMs);
    this.#els.bytes.textContent = formatBytes(metrics.frameBytes);
    this.#els.qualityValue.textContent = stream.serverQuality || stream.quality;

    for (const button of this.#els.quality.querySelectorAll('.pill')) {
      button.dataset.active = String(button.dataset.quality === stream.quality);
    }
  }
}
