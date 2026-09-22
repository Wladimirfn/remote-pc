import { AudioStreamPlayer } from './audio/player.js';
import { bus, Events } from './core/events.js';
import { patch, resetState, store } from './core/state.js';
import { ClipboardController } from './input/clipboard.js';
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
const FULLSCREEN_SETTLE_DELAY = 250;

const session = {
  api: null,
  stream: null,
  sid: null,
  monitorId: null,
  monitors: [],
  quality: 'auto',
  streamViewport: null,
  streamEpoch: 0,
  viewportTimer: 0,
  healTimer: 0,
  restoreQualityTimer: 0,
  moveInFlight: false,
  pendingMove: null,
  extraMonitorActive: false,
  extraMonitorBusy: false,
};

let views = null;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    isTopbarVisible: () => Boolean(views?.topbarView?.visible),
  };
}

function scheduleKeyframeHeal(delayMs = 320) {
  clearTimeout(session.healTimer);
  clearTimeout(session.restoreQualityTimer);
  session.healTimer = setTimeout(async () => {
    session.healTimer = 0;
    const api = session.api;
    const sid = session.sid;
    const targetQuality = session.quality || 'auto';
    if (!api || !sid || !session.stream?.running) return;
    try {
      await api.setQuality({ sid, quality: 73 });
      session.restoreQualityTimer = setTimeout(() => {
        session.restoreQualityTimer = 0;
        if (session.api === api && session.sid === sid) {
          api.setQuality({ sid, quality: targetQuality }).catch(() => {});
        }
      }, 90);
    } catch {
      /* el stream puede estar reconectando */
    }
  }, delayMs);
}

function sendInput(payload) {
  const api = session.api;
  if (!api) return;

  if (payload.type !== 'move') {
    if (payload.type === 'down') {
      void views?.clipboard?.pushToRemote();
    }
    api.sendInput(payload).catch((error) => console.warn('[input]', error.message));
    if (
      payload.type === 'up' ||
      payload.type === 'click' ||
      (payload.type === 'keyUp' &&
        (payload.code === 'Escape' || payload.code === 'Enter' || payload.code === 'F4' || payload.code === 'KeyW'))
    ) {
      scheduleKeyframeHeal(320);
      if (payload.type === 'up' || payload.type === 'click') {
        views?.clipboard?.schedulePullFromRemote(240);
      }
    }
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
  if (isFullscreen) views?.keyboard?.lockSystemKeyboard();
  else views?.keyboard?.unlockSystemKeyboard();
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
  await wait(FULLSCREEN_SETTLE_DELAY);
  await nextFrame();
  views.canvasView.fit();

  const settled = views.canvasView.viewport;
  session.streamViewport = settled.width && settled.height ? { ...settled } : null;

  const started = await startStream();
  if (!started) {
    const message = store.get().stream.error ?? 'No se pudo iniciar la transmisión de pantalla.';
    await teardown();
    throw new Error(message);
  }

  views.clipboard.reset();
  void views.clipboard.pushToRemote();
  void views.audio.start(api);
  views.topbarView.setAudioMuted(views.audio.muted);

  if (profile.extraMonitor) await setExtraMonitor(true, { silent: true });

  return { ...profile, baseUrl };
}

async function startStream({ silent = false } = {}) {
  const api = session.api;
  if (!api) return false;

  await stopStream();
  if (!silent) setStatusOverlay('loading', 'Conectando al monitor…');

  const viewport = views.canvasView.viewport;
  const epoch = (session.streamEpoch = (session.streamEpoch || 0) + 1);
  session.sid = createSessionId();

  const stream = new ScreenStream({
    api,
    onFrame: (payload) => handleFrame(stream, payload),
    onControl: (message) => handleControl(stream, message),
    onStale: (error) => handleStreamStale(stream, error),
    onStats: (stats) => {
      if (session.stream !== stream) return;
      patch('metrics', stats);
    },
    onError: (error) => handleStreamFailure(stream, error),
    onEnd: () => handleStreamFailure(stream, new Error('El servidor cerró la transmisión.')),
  });

  session.stream = stream;
  session.streamViewport = viewport.width && viewport.height ? { ...viewport } : null;
  patch('stream', {
    status: 'starting',
    sid: session.sid,
    monitorId: session.monitorId,
    quality: session.quality,
    error: null,
  });

  const jitter = (epoch % 3) * 2;
  const width = Math.max(320, Math.round(viewport.width || 1920) - jitter);
  const height = Math.max(240, Math.round(viewport.height || 1080) - jitter);

  try {
    await stream.start({
      sid: session.sid,
      monitor: session.monitorId,
      quality: session.quality,
      viewportW: width,
      viewportH: height,
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
  scheduleKeyframeHeal(220);
  return true;
}

async function stopStream() {
  clearTimeout(session.viewportTimer);
  clearTimeout(session.healTimer);
  clearTimeout(session.restoreQualityTimer);
  session.viewportTimer = 0;
  session.healTimer = 0;
  session.restoreQualityTimer = 0;
  session.pendingMove = null;

  const stream = session.stream;
  session.stream = null;
  if (stream) await stream.stop();
}

async function handleFrame(stream, { meta, jpeg }) {
  if (session.stream !== stream) return;
  await views.canvasView.renderFrame(meta, jpeg);

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

function handleStreamStale(stream, error) {
  if (session.stream !== stream) return;
  console.warn('[stream] reinicio automático:', error?.message || 'sin actividad');
  void startStream({ silent: true });
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

async function setExtraMonitor(enabled, { silent = false } = {}) {
  if (!session.api || session.extraMonitorBusy) return;
  const api = session.api;
  session.extraMonitorBusy = true;
  views.topbarView.setExtraMonitor(session.extraMonitorActive, true);

  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1280, Math.round((window.screen?.width || 1920) * (dpr > 1.5 ? 1 : dpr)));
  const height = Math.max(720, Math.round((window.screen?.height || 1080) * (dpr > 1.5 ? 1 : dpr)));

  const previousNames = new Set(session.monitors.map((m) => m.name));
  const previousCount = session.monitors.length;

  try {
    // Pausamos el stream antes de cambiar la topología de pantallas en Windows
    // para que ningún capture concurrente choque con el cambio de modo gráfico (WM_DISPLAYCHANGE).
    await stopStream();

    const result = await api.setVirtualDisplay({ enabled, width, height });
    if (session.api !== api) return;

    await wait(350);

    // Consultamos de nuevo api.getMonitors() tras el settle de DWM para asegurar
    // que el monitor N+1 recién agregado aparezca enumerado junto a los físicos.
    const freshPayload = await api.getMonitors().catch(() => result?.monitors);
    const monitors = normalizeMonitors(freshPayload?.length ? freshPayload : result?.monitors);
    session.monitors = monitors;
    store.set({ monitors });

    const addedMonitor = monitors.find((monitor) => !previousNames.has(monitor.name));
    const hasAddedMonitor = Boolean(addedMonitor) || monitors.length > previousCount;
    session.extraMonitorActive = enabled ? Boolean(result?.active ?? hasAddedMonitor) : false;
    patch('stream', { extraMonitor: session.extraMonitorActive });

    const requestedId = Number(result?.monitorId);
    let target;
    if (session.extraMonitorActive) {
      target =
        addedMonitor ??
        (Number.isFinite(requestedId) ? monitors.find((monitor) => monitor.id === requestedId) : null) ??
        monitors[monitors.length - 1];
    } else {
      target = monitors.find((monitor) => monitor.primary) ?? monitors[0];
    }
    if (!target) throw new Error('El servidor no reportó monitores tras cambiar el modo Monitor Extra.');
    if (session.api !== api) return;

    session.monitorId = target.id;
    patch('stream', { monitorId: target.id });
    views.topbarView.setMonitors(monitors, session.monitorId);
    views.canvasView.setRemoteSize(target.width, target.height);

    const started = await startStream({ silent: true });
    if (!started && session.api === api) {
      await wait(400);
      await startStream({ silent: true });
    }
  } catch (error) {
    const message = error?.message || 'No se pudo cambiar el modo Monitor Extra.';
    console.warn('[extra-monitor]', message);
    if (session.api === api && !session.stream) {
      await wait(300);
      await startStream({ silent: true });
    }
  } finally {
    session.extraMonitorBusy = false;
    views.topbarView.setExtraMonitor(session.extraMonitorActive, false);
  }
}

async function changeQuality(quality) {
  if (!session.api || quality === session.quality) return;
  const api = session.api;
  const sid = session.sid;
  session.quality = quality;
  patch('stream', { quality });
  views.topbarView.setQuality(quality);

  if (sid) {
    try {
      await api.setQuality({ sid, quality });
      return;
    } catch (error) {
      console.warn('[quality] cambio en vivo no disponible:', error.message);
    }
    if (session.api !== api || session.quality !== quality) return;
  }

  await startStream({ silent: true });
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
  if (session.extraMonitorActive && session.api) {
    await session.api.setVirtualDisplay({ enabled: false }).catch(() => {});
  }
  await views.audio?.stop();
  views.clipboard?.reset();
  views.keyboard?.unlockSystemKeyboard();
  session.api = null;
  session.sid = null;
  session.monitors = [];
  session.monitorId = null;
  session.streamViewport = null;
  session.moveInFlight = false;
  session.extraMonitorActive = false;
  session.extraMonitorBusy = false;

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
  bus.on(Events.RefreshStream, () => void startStream({ silent: true }));
  bus.on(Events.ToggleExtraMonitor, () => void setExtraMonitor(!session.extraMonitorActive));
  bus.on(Events.ToggleAudio, () => {
    if (!views.audio) return;
    const muted = views.audio.toggleMute();
    views.topbarView.setAudioMuted(muted);
  });
  bus.on(Events.ToggleFullscreen, () => void toggleFullscreen());
  bus.on(Events.ToggleTopbar, () => views.topbarView.toggle());
  bus.on(Events.Escape, () => {
    if (views.topbarView.visible) {
      views.topbarView.hide();
      return;
    }
    if (store.get().ui.fullscreen) void exitFullscreen();
  });
  bus.on(Events.Disconnect, () => void disconnect());
}

function wireLifecycle() {
  window.addEventListener('resize', () => views.canvasView.fit());
  document.addEventListener('fullscreenchange', () => setFullscreenState(Boolean(document.fullscreenElement)));
  window.addEventListener('beforeunload', () => {
    void session.stream?.stop();
    if (session.extraMonitorActive && session.api) {
      void session.api.setVirtualDisplay({ enabled: false }).catch(() => {});
    }
    void views?.audio?.stop();
  });
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
    topbarTrigger: document.querySelector('#topbar-trigger'),
  };

  const canvasView = new CanvasView(els.canvas, { stage: els.stage, onViewportChange: handleViewportChange });
  const topbarView = new TopbarView({ root: els.topbar, trigger: els.topbarTrigger });
  const connectionView = new ConnectionView({ form: els.form, onConnect: connect });
  const clipboard = new ClipboardController({
    getApi: () => session.api,
    getInputContext: inputContext,
  });
  const audio = new AudioStreamPlayer();

  views = { els, canvasView, topbarView, connectionView, clipboard, audio };
  views.mouse = new MouseController(els.canvas, { getContext: inputContext });
  views.keyboard = new KeyboardController({ getContext: inputContext, clipboard });

  topbarView.mount();
  connectionView.mount();
  clipboard.attach();
  views.mouse.attach();
  views.keyboard.attach();

  els.statusAction.addEventListener('click', () => void disconnect());
  topbarView.setFullscreen(false);
  topbarView.setAudioMuted(false);

  wireBus();
  wireLifecycle();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap);
else bootstrap();
