const STORAGE_KEY = 'idupi.connection.v1';

function readStorage() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStorage(profile) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* almacenamiento no disponible */
  }
}

export class ConnectionView {
  #els;
  #onConnect;
  #busy = false;

  constructor({ form, onConnect }) {
    this.#onConnect = onConnect;
    this.#els = {
      form,
      host: form.querySelector('#input-host'),
      port: form.querySelector('#input-port'),
      token: form.querySelector('#input-token'),
      toggleToken: form.querySelector('#btn-toggle-token'),
      submit: form.querySelector('#btn-connect'),
      submitLabel: form.querySelector('#btn-connect-label'),
      error: form.querySelector('#connection-error'),
      badge: form.querySelector('#connection-badge'),
    };
  }

  mount() {
    this.#restore();
    this.#els.form.addEventListener('submit', this.#onSubmit);
    this.#els.toggleToken.addEventListener('click', this.#toggleToken);
    this.#els.host.focus();
  }

  setBusy(busy, label = 'Conectar') {
    this.#busy = busy;
    this.#els.submit.disabled = busy;
    this.#els.submitLabel.textContent = busy ? label : 'Conectar';
  }

  setError(message) {
    const box = this.#els.error;
    box.textContent = message ?? '';
    box.hidden = !message;
    if (message) {
      box.style.animation = 'none';
      void box.offsetWidth;
      box.style.animation = '';
    }
  }

  clearError() {
    this.setError(null);
  }

  setStatus(state, label) {
    const badge = this.#els.badge;
    badge.dataset.state = state;
    badge.textContent = label;
  }

  focus() {
    this.#els.token.focus();
    this.#els.token.select();
  }

  save(profile) {
    writeStorage({ host: profile.host, port: profile.port ?? '', token: profile.token, baseUrl: profile.baseUrl ?? '' });
  }

  #restore() {
    const saved = readStorage();
    if (!saved) return;
    if (saved.host) this.#els.host.value = saved.host;
    if (saved.port !== undefined && saved.port !== null && saved.port !== '') this.#els.port.value = saved.port;
    if (saved.token) this.#els.token.value = saved.token;
  }

  #toggleToken = () => {
    const isPassword = this.#els.token.type === 'password';
    this.#els.token.type = isPassword ? 'text' : 'password';
    this.#els.toggleToken.textContent = isPassword ? 'ocultar' : 'ver';
    this.#els.token.focus();
  };

  #readProfile() {
    const host = this.#els.host.value.trim() || 'localhost';
    const port = this.#els.port.value.trim();
    const token = this.#els.token.value.trim();

    if (/^https?:\/\//i.test(host)) {
      try {
        new URL(host);
      } catch {
        throw new Error('El host no es una URL válida.');
      }
    }

    let portNumber = null;
    if (port) {
      portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        throw new Error('El puerto debe ser un número entre 1 y 65535.');
      }
    }

    return { host, port: portNumber, token };
  }

  #onSubmit = async (event) => {
    event.preventDefault();
    if (this.#busy) return;

    let profile;
    try {
      profile = this.#readProfile();
    } catch (error) {
      this.setError(error.message);
      return;
    }

    this.clearError();
    this.setBusy(true, 'Conectando…');
    this.setStatus('connecting', 'Conectando');

    try {
      const connected = await this.#onConnect(profile);
      this.save(connected ?? profile);
      this.setBusy(false);
      this.setStatus('connected', 'Conectado');
    } catch (error) {
      this.setBusy(false);
      this.setStatus('error', 'Error');
      this.setError(error?.message || 'No se pudo conectar con el servidor.');
    }
  };
}
