import { toApiError, ApiError } from './api.js';
import { MessageKind, ProtocolDecoder } from './protocol.js';

const STATS_INTERVAL = 300;
const FPS_WINDOW = 1500;

export class ScreenStream {
  #api;
  #handlers;
  #controller = null;
  #reader = null;
  #decoder = null;
  #loopPromise = null;
  #statsTimer = 0;
  #running = false;
  #session = { sid: null, monitor: null, quality: 'auto' };
  #frameTimes = [];
  #stats = {
    fps: 0,
    latencyMs: 0,
    renderMs: 0,
    frameBytes: 0,
    frames: 0,
    frameId: null,
    quality: null,
    serverQuality: null,
  };

  constructor({ api, onFrame, onControl, onError, onEnd, onStats }) {
    this.#api = api;
    this.#handlers = { onFrame, onControl, onError, onEnd, onStats };
    this.#stats.quality = null;
  }

  get running() {
    return this.#running;
  }

  get stats() {
    return { ...this.#stats };
  }

  async start({ sid, monitor, quality = 'auto', viewportW, viewportH }) {
    await this.stop();

    this.#session = { sid, monitor, quality };
    this.#resetStats();

    const controller = new AbortController();
    this.#controller = controller;

    let response;
    try {
      response = await this.#api.openStream(
        { sid, monitor, viewportW, viewportH, quality },
        { signal: controller.signal },
      );
    } catch (error) {
      this.#controller = null;
      if (error instanceof ApiError) throw error;
      throw new ApiError('No se pudo abrir la transmisión de pantalla.', { code: 'network', cause: error });
    }

    if (!response.ok) {
      this.#controller = null;
      throw await toApiError(response);
    }

    if (!response.body) {
      this.#controller = null;
      throw new ApiError('El servidor no devolvió un flujo de datos.', { code: 'protocol' });
    }

    this.#running = true;
    this.#reader = response.body.getReader();
    this.#decoder = new ProtocolDecoder();
    this.#statsTimer = setInterval(() => this.#emitStats(), STATS_INTERVAL);
    this.#loopPromise = this.#consume();

    return this.#stats;
  }

  async stop() {
    const wasRunning = this.#running;
    this.#running = false;

    if (this.#statsTimer) {
      clearInterval(this.#statsTimer);
      this.#statsTimer = 0;
    }

    const reader = this.#reader;
    const controller = this.#controller;
    this.#reader = null;
    this.#controller = null;

    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* el flujo ya estaba cerrado */
      }
    }

    controller?.abort();

    if (this.#loopPromise) {
      try {
        await this.#loopPromise;
      } catch {
        /* el bucle propaga sus propios errores */
      }
      this.#loopPromise = null;
    }

    this.#decoder = null;
    return wasRunning;
  }

  async #consume() {
    try {
      while (this.#running) {
        const { done, value } = await this.#reader.read();
        if (done) break;

        const messages = this.#decoder.push(value);
        for (const message of messages) {
          if (!this.#running) break;
          if (message.kind === MessageKind.FRAME) await this.#handleFrame(message);
          else if (message.kind === MessageKind.CONTROL) this.#handleControl(message.message);
        }
      }

      if (this.#running) {
        this.#running = false;
        this.#handlers.onEnd?.();
      }
    } catch (error) {
      if (!this.#running || error?.name === 'AbortError') return;
      this.#running = false;
      this.#handlers.onError?.(
        error instanceof ApiError
          ? error
          : new ApiError('La transmisión se interrumpió.', { code: 'stream', cause: error }),
      );
    }
  }

  async #handleFrame({ meta, jpeg }) {
    const startedAt = performance.now();
    let bitmap = null;

    try {
      if (jpeg.byteLength > 0) {
        bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      }
      await this.#handlers.onFrame?.({ meta, bitmap, jpegBytes: jpeg.byteLength });
    } catch (error) {
      console.error('[stream] no se pudo renderizar el frame', error);
    } finally {
      bitmap?.close?.();
    }

    const bytes = Number(meta?.bytes) || jpeg.byteLength;
    this.#stats.renderMs = Math.round(performance.now() - startedAt);
    this.#stats.frameBytes = bytes;
    this.#stats.frames += 1;
    this.#stats.frameId = meta?.id ?? this.#stats.frames;
    if (meta?.quality) this.#stats.serverQuality = meta.quality;

    const now = performance.now();
    this.#frameTimes.push(now);
    while (this.#frameTimes.length && now - this.#frameTimes[0] > FPS_WINDOW) this.#frameTimes.shift();

    const ackStartedAt = performance.now();
    try {
      await this.#api.ack({
        sid: this.#session.sid,
        frameId: this.#stats.frameId,
        bytes,
        renderMs: this.#stats.renderMs,
      });
      this.#stats.latencyMs = Math.round(performance.now() - ackStartedAt);
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('[stream] ACK rechazado:', error.message);
    }
  }

  #handleControl(message) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.name === 'string' && (message.type === 'quality_changed' || message.type === 'quality')) {
      this.#stats.serverQuality = message.name;
    }
    this.#handlers.onControl?.(message);
  }

  #resetStats() {
    this.#frameTimes = [];
    this.#stats = {
      fps: 0,
      latencyMs: 0,
      renderMs: 0,
      frameBytes: 0,
      frames: 0,
      frameId: null,
      quality: this.#session.quality,
      serverQuality: null,
    };
  }

  #emitStats() {
    if (!this.#running) return;
    const now = performance.now();
    while (this.#frameTimes.length && now - this.#frameTimes[0] > FPS_WINDOW) this.#frameTimes.shift();
    this.#stats.fps = Math.round((this.#frameTimes.length / FPS_WINDOW) * 1000);
    this.#handlers.onStats?.(this.stats);
  }
}
