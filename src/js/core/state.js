export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  function get() {
    return state;
  }

  function set(patch) {
    if (!patch) return state;
    const partial = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...partial };
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        console.error('[store] fallo en un suscriptor', error);
      }
    }
    return state;
  }

  function subscribe(listener, { immediate = false } = {}) {
    listeners.add(listener);
    if (immediate) listener(state);
    return () => listeners.delete(listener);
  }

  return { get, set, subscribe };
}

export function createInitialState() {
  return {
    connection: {
      host: 'localhost',
      port: 8788,
      token: '',
      baseUrl: '',
      status: 'idle',
      error: null,
    },
    config: {
      remoteInputEnabled: true,
    },
    monitors: [],
    stream: {
      status: 'idle',
      sid: null,
      monitorId: null,
      quality: 'auto',
      serverQuality: null,
      extraMonitor: false,
      error: null,
    },
    metrics: {
      fps: 0,
      latencyMs: 0,
      renderMs: 0,
      frameBytes: 0,
      frames: 0,
      frameId: null,
    },
    ui: {
      fullscreen: false,
      topbarVisible: false,
      viewportWidth: 0,
      viewportHeight: 0,
      remoteWidth: 0,
      remoteHeight: 0,
    },
  };
}

export const store = createStore(createInitialState());

export function patch(section, values) {
  const current = store.get()[section];
  return store.set({ [section]: { ...current, ...values } });
}

export function resetState() {
  const current = store.get();
  const next = createInitialState();
  next.connection.host = current.connection.host;
  next.connection.port = current.connection.port;
  next.connection.token = current.connection.token;
  return store.set(next);
}
