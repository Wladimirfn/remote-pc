import { bus, Events } from './core/events.js';
import { patch, resetState, store } from './core/state.js';
import { MouseController } from './input/mouse.js';
import { KeyboardController } from './input/keyboard.js';
import { ScreenApi, normalizeBaseUrl } from './network/api.js';
import { ScreenStream } from './network/stream.js';
import { CanvasView } from './ui/canvas.js';
import { ConnectionView } from './ui/connection.js';
import { TopbarView } from './ui/topbar.js';

const desktop = window.idupiDesktop ?? null;
const VIEWPORT_RESTART_DELAY = 700;
const VIEWPORT_RESTART_RATIO = 0.15;

const session = {
  api: null,
  stream: null,
  sid: null,
  monitorId: null,
  monitors: [],
  quality: 'auto',
  streamViewport: null,
  viewportTimer: 0,
  moveInFlight: false,
  pendingMove: null,
};

let views = null;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function createSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `sid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeMonitors(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.monitors) ? payload.monitors : [];
  return list
    .map((monitor, index) => ({
      id: Number.isFinite(Number(monitor?.id)) ? Number(monitor.id) : index,
      name: monitor?.name ?? `Monitor ${index + 1}`,
      primary: Boolean(monitor?.primary),
      x: Number(monitor?.x) || 0,
      y: Number(monitor?.y) || 0,
      width: Math.max(0, Math.round(Number(monitor?.width) || 0)),
      height: Math.max(0, Math.round(Number(monitor?.height) || 0)),
      scaleFactor: Number(monitor?.scaleFactor) || 1,
    }))
    .sort((a, b) => a.id - b.id);
}

function inputContext() {
  return {
    monitor: session.monitorId,
    enabled: Boolean(session.api) && store.get().config.remoteInputEnabled,
    send: sendInput,
  };
}

function sendInput(payload) {
  const api = session.api;
  if (!api) return;

  if (payload.type !== 'move') {
    api.sendInput(payload).catch((error) => console.warn('[input]', error.message));
    return;
  }

  session.pendingMove = payload;
  if (session.moveInFlight) return;
  void flushMoves(api);
}

async function flushMoves(api) {
  session.moveInFlight = true;
  while (session.pendingMove && session.api === api) {
    const payload = session.pendingMove;
    session.pendingMove = null;
    try {
      await api.sendInput(payload);
    } catch (error) {
      console.warn('[input]', error.message);
      break;
    }
  }
  session.moveInFlight = false;
}

function setStatusOverlay(state, message, actionLabel = null) {
  const { status, statusText, statusAction } = views.els;
  if (!message) {
    status.hidden = true;
    return;
  }
  status.hidden = false;
  status.dataset.state = state ?? 'loading';
  statusText.textContent = message;
  statusAction.hidden = !actionLabel;
  statusAction.textContent = actionLabel ?? '';
}

function setFullscreenState(value) {
  const isFullscreen = Boolean(value);
  if (store.get().ui.fullscreen === isFullscreen) return;
  patch('ui', { fullscreen: isFullscreen });
  views.topbarView.setFullscreen(isFullscreen);
}

async function enterFullscreen() {
  if (desktop?.setFullscreen) {
    setFullscreenState(await desktop.setFullscreen(true));
    return;
  }
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch (error) {
      console.warn('[fullscreen] no disponible', error.message);
    }
  }
  setFullscreenState(Boolean(document.fullscreenElement));
}

async function exitFullscreen() {
  if (desktop?.setFullscreen) {
    setFullscreenState(await desktop.setFullscreen(false));
    return;
  }
  if (document.fullscreenElement) {
    try {
      await document.exitFullscreen();
    } catch (error) {
      console.warn('[fullscreen] no se pudo salir', error.message);
    }
  }
  setFullscreenState(false);
}

async function toggleFullscreen() {
  if (desktop?.toggleFullscreen) {
    setFullscreenState(await desktop.toggleFullscreen());
    return;
  }
  if (document.fullscreenElement) await exitFullscreen();
  else await enterFullscreen();
}

async function connect(profile) {
  const baseUrl = normalizeBaseUrl(profile.host, profile.port);
  const api = new ScreenApi({ baseUrl, token: profile.token });

  setStatusOverlay('loading', 'Validando servidor…');

  const [config, monitorsPayload] = await Promise.all([api.getConfig(), api.getMonitors()]);
  const monitors = normalizeMonitors(monitorsPayload);
  if (!monitors.length) throw new Error('El servidor no reportó ningún monitor disponible.');

  session.api = api;
  session.sid = createSessionId();
  session.monitors = monitors;
  session.quality = 'auto';
  session.monitorId = (monitors.find((monitor) => monitor.primary) ?? monitors[0]).id;

  store.set({
    connection: {
      host: profile.host,
      port: profile.port ?? 8788,
      token: profile.token,
      baseUrl,
      status: 'connected',
      error: null,
    },
    config: { remoteInputEnabled: config?.remoteInputEnabled !== false },
    monitors,
    stream: {
      status: 'idle',
      sid: session.sid,
      monitorId: session.monitorId,
      quality: session.quality,
      serverQuality: null,
      error: null,
    },
  });

  showViewer();
  views.topbarView.setMonitors(monitors, session.monitorId);
  views.topbarView.setQuality(session.quality);

  const target = monitors.find((monitor) => monitor.id === session.monitorId);
  if (target?.width && target?.height) views.canvasView.setRemoteSize(target.width, target.height);

  await enterFullscreen();
  await nextFrame();
  views.canvasView.fit();

  const started = await startStream();
  if (!started) {
    const message = store.get().stream.error ?? 'No se pudo iniciar la transmisión de pantalla.';
    await teardown();
    throw new Error(message);
  }

  return { ...profile, baseUrl };
}

async function startStream({ silent = false } = {}) {
  const api = session.api;
  if (!api) return false;

  await stopStream();
  if (!silent) setStatusOverlay('loading', 'Conectando al monitor…');

  const viewport = views.canvasView.viewport;

  const stream = new ScreenStream({
    api,
    onFrame: (payload) => handleFrame(stream, payload),
    onControl: (message) => handleControl(stream, message),
    onStats: (stats) => {
      if (session.stream !== stream) return;
      patch('metrics', stats);
    },
    onError: (error) => handleStreamFailure(stream, error),
    onEnd: () => handleStreamFailure(stream, new Error('El servidor cerró la transmisión.')),
  });

  session.stream = stream;
  session.streamViewport = viewport.width && viewport.height ? { ...viewport } : null;
  patch('stream', { status: 'starting', monitorId: session.monitorId, quality: session.quality, error: null });

  try {
    await stream.start({
      sid: session.sid,
      monitor: session.monitorId,
      quality: session.quality,
      viewportW: viewport.width || 1920,
      viewportH: viewport.height || 1080,
    });
  } catch (error) {
    if (session.stream === stream) {
      session.stream = null;
      patch('stream', { status: 'error', error: error.message });
      setStatusOverlay('error', error.message, 'Volver');
    }
    return false;
  }

  if (session.stream !== stream) return false;

  patch('stream', { status: 'streaming', error: null });
  setStatusOverlay(null);
  return true;
}

async function stopStream() {
  clearTimeout(session.viewportTimer);
  session.viewportTimer = 0;
  session.pendingMove = null;

  const stream = session.stream;
  session.stream = null;
  if (stream) await stream.stop();
}

function handleFrame(stream, { meta, bitmap }) {
  if (session.stream !== stream) return;
  views.canvasView.draw(meta, bitmap);

  const remoteWidth = Number(meta?.w) || 0;
  const remoteHeight = Number(meta?.h) || 0;
  const { ui } = store.get();
  if (remoteWidth && remoteHeight && (ui.remoteWidth !== remoteWidth || ui.remoteHeight !== remoteHeight)) {
    patch('ui', { remoteWidth, remoteHeight });
  }
}

function handleControl(stream, message) {
  if (session.stream !== stream) return;
  if (typeof message?.name === 'string' && message.type?.startsWith('quality')) {
    patch('stream', { serverQuality: message.name });
  }
}

function handleStreamFailure(stream, error) {
  if (session.stream !== stream) return;
  session.stream = null;
  const message = error?.message || 'La transmisión se interrumpió.';
  patch('stream', { status: 'error', error: message });
  setStatusOverlay('error', message, 'Volver');
}

async function switchMonitor(monitorId) {
  if (!session.api || monitorId === session.monitorId) return;
  const monitor = session.monitors.find((item) => item.id === monitorId);
  if (!monitor) return;

  session.monitorId = monitorId;
  patch('stream', { monitorId });
  views.topbarView.setMonitors(session.monitors, monitorId);
  if (monitor.width && monitor.height) views.canvasView.setRemoteSize(monitor.width, monitor.height);

  await startStream();
}

async function changeQuality(quality) {
  if (!session.api || quality === session.quality) return;
  session.quality = quality;
  patch('stream', { quality });
  views.topbarView.setQuality(quality);
  await startStream();
}

function handleViewportChange({ width, height }) {
  patch('ui', { viewportWidth: width, viewportHeight: height });
  if (!session.stream || !session.streamViewport) return;

  clearTimeout(session.viewportTimer);
  session.viewportTimer = setTimeout(() => {
    session.viewportTimer = 0;
    const previous = session.streamViewport;
    if (!session.stream || !previous) return;
    const changed =
      Math.abs(width - previous.width) / previous.width > VIEWPORT_RESTART_RATIO ||
      Math.abs(height - previous.height) / previous.height > VIEWPORT_RESTART_RATIO;
    if (changed) void startStream({ silent: true });
  }, VIEWPORT_RESTART_DELAY);
}

async function teardown() {
  await stopStream();
  session.api = null;
  session.sid = null;
  session.monitors = [];
  session.monitorId = null;
  session.streamViewport = null;
  session.moveInFlight = false;

  views.canvasView.reset();
  setStatusOverlay(null);
  resetState();
  await exitFullscreen();
}

async function disconnect(message = null) {
  await teardown();
  showConnection(message);
}

function showViewer() {
  views.els.connectionScreen.hidden = true;
  views.els.viewerScreen.hidden = false;
  views.topbarView.hide();
  views.connectionView.setStatus('connected', 'Conectado');
}

function showConnection(message) {
  views.els.viewerScreen.hidden = true;
  views.els.connectionScreen.hidden = false;
  views.topbarView.hide();
  views.connectionView.setBusy(false);
  views.connectionView.setStatus('idle', 'Desconectado');
  if (message) views.connectionView.setError(message);
  views.connectionView.focus();
}

function wireBus() {
  bus.on(Events.MonitorSelect, (monitorId) => void switchMonitor(Number(monitorId)));
  bus.on(Events.MonitorSelectIndex, (index) => {
    const monitor = session.monitors[index - 1];
    if (monitor) void switchMonitor(monitor.id);
  });
  bus.on(Events.QualityChange, (quality) => void changeQuality(quality));
  bus.on(Events.ToggleFullscreen, () => void toggleFullscreen());
  bus.on(Events.Escape, () => {
    if (store.get().ui.fullscreen) void exitFullscreen();
    else views.topbarView.toggle();
  });
  bus.on(Events.Disconnect, () => void disconnect());
}

function wireLifecycle() {
  window.addEventListener('resize', () => views.canvasView.fit());
  document.addEventListener('fullscreenchange', () => setFullscreenState(Boolean(document.fullscreenElement)));
  window.addEventListener('beforeunload', () => void session.stream?.stop());
  desktop?.onFullscreenChange?.((value) => setFullscreenState(value));
}

function bootstrap() {
  const els = {
    connectionScreen: document.querySelector('#connection-screen'),
    viewerScreen: document.querySelector('#viewer-screen'),
    form: document.querySelector('#connection-form'),
    stage: document.querySelector('#viewer-stage'),
    canvas: document.querySelector('#remote-canvas'),
    status: document.querySelector('#viewer-status'),
    statusText: document.querySelector('#viewer-status-text'),
    statusAction: document.querySelector('#viewer-status-action'),
    topbar: document.querySelector('#topbar'),
    topbarZone: document.querySelector('#topbar-zone'),
  };

  const canvasView = new CanvasView(els.canvas, { stage: els.stage, onViewportChange: handleViewportChange });
  const topbarView = new TopbarView({ root: els.topbar, zone: els.topbarZone });
  const connectionView = new ConnectionView({ form: els.form, onConnect: connect });

  views = { els, canvasView, topbarView, connectionView };
  views.mouse = new MouseController(els.canvas, { getContext: inputContext });
  views.keyboard = new KeyboardController({ getContext: inputContext });

  topbarView.mount();
  connectionView.mount();
  views.mouse.attach();
  views.keyboard.attach();

  els.statusAction.addEventListener('click', () => void disconnect());
  topbarView.setFullscreen(false);

  wireBus();
  wireLifecycle();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
