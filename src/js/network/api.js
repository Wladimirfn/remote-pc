const DEFAULT_TIMEOUT = 12000;

const HTTP_MESSAGES = {
  400: 'Solicitud inválida',
  401: 'Token inválido o no autorizado',
  403: 'Acceso denegado por el servidor',
  404: 'Recurso no encontrado en el servidor',
  409: 'Conflicto de sesión remota',
  429: 'Demasiadas solicitudes al servidor',
  500: 'Error interno del servidor',
  502: 'Puerta de enlace no disponible',
  503: 'Servicio no disponible',
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, cause = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }

  get isAuth() {
    return this.status === 401 || this.status === 403;
  }

  get isNetwork() {
    return this.code === 'network';
  }
}

export async function toApiError(response) {
  let detail = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const payload = JSON.parse(text);
        detail = payload.message || payload.error || payload.detail || payload.title || '';
      } catch {
        detail = text.slice(0, 200);
      }
    }
  } catch {
    detail = '';
  }
  const base = HTTP_MESSAGES[response.status] || `Error HTTP ${response.status}`;
  return new ApiError(detail && !base.includes(detail) ? `${base}: ${detail}` : base, {
    status: response.status,
    code: 'http',
  });
}

export function normalizeBaseUrl(host, port) {
  const raw = String(host ?? '').trim();
  const portValue = String(port ?? '').trim();

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const path = url.pathname.replace(/\/+$/, '');
      const query = url.search || '';
      return `${url.origin}${path}${query}`;
    } catch {
      throw new ApiError('La URL del host no es válida.', { code: 'input' });
    }
  }

  const normalizedHost = (raw || 'localhost').replace(/\/+$/, '');
  const suffix = portValue ? `:${portValue}` : '';
  return `http://${normalizedHost}${suffix}`;
}

export class ScreenApi {
  #baseUrl;
  #token;
  #timeoutMs;

  constructor({ baseUrl, token = '', timeoutMs = DEFAULT_TIMEOUT }) {
    this.#baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.#token = token || '';
    this.#timeoutMs = timeoutMs;
  }

  get baseUrl() {
    return this.#baseUrl;
  }

  url(path) {
    return `${this.#baseUrl}${path}`;
  }

  authHeaders(extra = {}) {
    const headers = { ...extra };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async request(path, { method = 'GET', body, signal, headers, timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.#timeoutMs);
    const relayAbort = () => controller.abort();

    if (signal) {
      if (signal.aborted) relayAbort();
      else signal.addEventListener('abort', relayAbort, { once: true });
    }

    try {
      const response = await fetch(this.url(path), {
        method,
        headers: this.authHeaders({
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok) throw await toApiError(response);
      if (response.status === 204) return null;

      const contentType = response.headers.get('content-type') || '';
      return contentType.includes('json') ? await response.json() : await response.text();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.name === 'AbortError') {
        if (signal?.aborted) throw error;
        throw new ApiError('El servidor no respondió a tiempo.', { code: 'timeout', cause: error });
      }
      throw new ApiError('No se pudo conectar con el servidor. Verifica el host, el puerto y la red.', {
        code: 'network',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    }
  }

  getConfig({ signal } = {}) {
    return this.request('/api/v1/screen/config', { signal });
  }

  getMonitors({ signal } = {}) {
    return this.request('/api/v1/screen/monitors', { signal });
  }

  ack({ sid, frameId, bytes, renderMs }, { signal } = {}) {
    return this.request('/api/v1/screen/ack', {
      method: 'POST',
      body: { sid, frameId, bytes, renderMs },
      signal,
      timeoutMs: 6000,
    });
  }

  setQuality({ sid, quality }, { signal } = {}) {
    return this.request('/api/v1/screen/quality', {
      method: 'POST',
      body: { sid, quality },
      signal,
      timeoutMs: 6000,
    });
  }

  sendInput(payload, { signal } = {}) {
    return this.request('/api/v1/screen/input', {
      method: 'POST',
      body: payload,
      signal,
      timeoutMs: 6000,
    });
  }

  openStream({ sid, monitor, viewportW, viewportH, quality }, { signal } = {}) {
    const params = new URLSearchParams({
      sid: String(sid),
      monitor: String(monitor),
      viewportW: String(Math.max(1, Math.round(viewportW))),
      viewportH: String(Math.max(1, Math.round(viewportH))),
      quality: quality || 'auto',
    });

    return fetch(this.url(`/api/v1/screen/stream?${params.toString()}`), {
      headers: this.authHeaders({ Accept: 'application/octet-stream' }),
      signal,
      cache: 'no-store',
    });
  }
}
