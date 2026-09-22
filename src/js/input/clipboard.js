const desktop = window.idupiDesktop ?? null;
const POLL_INTERVAL_MS = 1800;

export class ClipboardController {
  #getApi;
  #getInputContext;
  #lastText = '';
  #pollTimer = 0;
  #attached = false;
  #serverSupported = true;

  constructor({ getApi, getInputContext }) {
    this.#getApi = getApi;
    this.#getInputContext = getInputContext;
  }

  attach() {
    if (this.#attached) return;
    this.#attached = true;
    window.addEventListener('focus', this.#onWindowFocus);
    this.#pollTimer = setInterval(() => {
      if (document.hasFocus()) void this.pullFromRemote();
    }, POLL_INTERVAL_MS);
  }

  detach() {
    if (!this.#attached) return;
    this.#attached = false;
    window.removeEventListener('focus', this.#onWindowFocus);
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = 0;
    }
  }

  reset() {
    this.#lastText = '';
    this.#serverSupported = true;
  }

  #onWindowFocus = () => {
    void this.pushToRemote();
  };

  async #readLocal() {
    try {
      if (desktop?.readClipboard) {
        return (await desktop.readClipboard()) ?? '';
      }
      if (navigator.clipboard?.readText) {
        return (await navigator.clipboard.readText()) ?? '';
      }
    } catch {
      /* sin permiso de lectura local */
    }
    return '';
  }

  async #writeLocal(text) {
    try {
      if (desktop?.writeClipboard) {
        await desktop.writeClipboard(text);
        return true;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* sin permiso de escritura local */
    }
    return false;
  }

  async pushToRemote({ force = false } = {}) {
    const api = this.#getApi?.();
    if (!api) return { synced: false, text: '' };

    const localText = await this.#readLocal();
    if (!localText) return { synced: false, text: '' };
    if (!force && localText === this.#lastText) {
      return { synced: true, text: localText };
    }

    if (this.#serverSupported) {
      try {
        await api.setClipboard(localText);
        this.#lastText = localText;
        return { synced: true, text: localText };
      } catch (error) {
        if (error?.status === 404) this.#serverSupported = false;
      }
    }

    return { synced: false, text: localText };
  }

  async pullFromRemote() {
    const api = this.#getApi?.();
    if (!api || !this.#serverSupported) return '';

    try {
      const res = await api.getClipboard();
      const remoteText = typeof res?.text === 'string' ? res.text : '';
      if (remoteText && remoteText !== this.#lastText) {
        this.#lastText = remoteText;
        await this.#writeLocal(remoteText);
      }
      return remoteText;
    } catch (error) {
      if (error?.status === 404) this.#serverSupported = false;
      return '';
    }
  }

  schedulePullFromRemote(delayMs = 160) {
    setTimeout(() => {
      void this.pullFromRemote();
    }, delayMs);
  }

  async handlePasteShortcut(sendVChord) {
    const { synced, text } = await this.pushToRemote({ force: true });
    if (synced || !text) {
      await sendVChord();
      return;
    }

    // Fallback: si el servidor remoto aún no tiene /api/v1/screen/clipboard,
    // inyectamos los caracteres UTF-16 directamente.
    const ctx = this.#getInputContext?.();
    if (!ctx?.enabled) return;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 13) continue;
      if (code === 10) {
        ctx.send({ type: 'keyvk', code: 0x0d });
      } else {
        ctx.send({ type: 'keychar', code });
      }
    }
    this.#lastText = text;
  }
}
