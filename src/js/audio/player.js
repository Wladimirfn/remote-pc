export class AudioStreamPlayer {
  #api = null;
  #controller = null;
  #ctx = null;
  #gainNode = null;
  #running = false;
  #muted = false;
  #nextStartTime = 0;
  #reconnectTimer = 0;

  get muted() {
    return this.#muted;
  }

  get running() {
    return this.#running;
  }

  setMuted(muted) {
    this.#muted = Boolean(muted);
    if (this.#gainNode && this.#ctx) {
      this.#gainNode.gain.setValueAtTime(this.#muted ? 0 : 1, this.#ctx.currentTime);
    }
    return this.#muted;
  }

  toggleMute() {
    return this.setMuted(!this.#muted);
  }

  async start(api) {
    await this.stop();
    if (!api) return false;

    this.#api = api;
    this.#running = true;
    void this.#consumeLoop(api);
    return true;
  }

  async stop() {
    this.#running = false;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = 0;
    }
    if (this.#controller) {
      this.#controller.abort();
      this.#controller = null;
    }
    if (this.#ctx) {
      try {
        await this.#ctx.close();
      } catch {
        /* contexto ya cerrado */
      }
      this.#ctx = null;
      this.#gainNode = null;
    }
    this.#nextStartTime = 0;
  }

  async #consumeLoop(api) {
    const controller = new AbortController();
    this.#controller = controller;

    try {
      const response = await api.openAudioStream({ signal: controller.signal });
      if (!response.ok || !response.body) {
        return;
      }

      const reader = response.body.getReader();
      let headerParsed = false;
      let sampleRate = 48000;
      let channels = 2;
      let leftover = new Uint8Array(0);

      while (this.#running && this.#api === api) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || !value.byteLength) continue;

        let chunk = value;
        if (leftover.byteLength > 0) {
          const merged = new Uint8Array(leftover.byteLength + chunk.byteLength);
          merged.set(leftover, 0);
          merged.set(chunk, leftover.byteLength);
          chunk = merged;
          leftover = new Uint8Array(0);
        }

        if (!headerParsed) {
          const nlIndex = chunk.indexOf(10); // '\n'
          if (nlIndex === -1) {
            leftover = chunk;
            continue;
          }
          const headerText = new TextDecoder().decode(chunk.subarray(0, nlIndex)).trim();
          try {
            const meta = JSON.parse(headerText);
            sampleRate = Number(meta.sampleRate) || 48000;
            channels = Math.max(1, Math.min(2, Number(meta.channels) || 2));
          } catch {
            sampleRate = 48000;
            channels = 2;
          }
          headerParsed = true;
          this.#initAudioContext(sampleRate);
          chunk = chunk.subarray(nlIndex + 1);
          if (!chunk.byteLength) continue;
        }

        const frameBytes = channels * 2; // s16le = 2 bytes per sample
        const usableBytes = Math.floor(chunk.byteLength / frameBytes) * frameBytes;
        if (usableBytes < chunk.byteLength) {
          leftover = chunk.subarray(usableBytes);
        }
        if (usableBytes > 0) {
          this.#schedulePcmChunk(chunk.subarray(0, usableBytes), sampleRate, channels);
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError' || !this.#running) return;
    }

    if (this.#running && this.#api === api) {
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = 0;
        if (this.#running && this.#api === api) void this.#consumeLoop(api);
      }, 2000);
    }
  }

  #initAudioContext(sampleRate) {
    if (this.#ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;

    this.#ctx = new AudioCtx({ sampleRate, latencyHint: 'interactive' });
    this.#gainNode = this.#ctx.createGain();
    this.#gainNode.gain.value = this.#muted ? 0 : 1;
    this.#gainNode.connect(this.#ctx.destination);
    this.#nextStartTime = this.#ctx.currentTime + 0.035;
  }

  #schedulePcmChunk(bytes, sampleRate, channels) {
    const ctx = this.#ctx;
    if (!ctx || !this.#gainNode) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const totalSamples = bytes.byteLength / 2;
    const frames = Math.floor(totalSamples / channels);
    if (frames <= 0) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const audioBuffer = ctx.createBuffer(channels, frames, sampleRate);

    for (let ch = 0; ch < channels; ch += 1) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let f = 0; f < frames; f += 1) {
        const s16 = view.getInt16((f * channels + ch) * 2, true);
        channelData[f] = s16 / 32768.0;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.#gainNode);

    const now = ctx.currentTime;
    if (this.#nextStartTime < now + 0.01) {
      this.#nextStartTime = now + 0.03;
    } else if (this.#nextStartTime > now + 0.18) {
      // Corrección de deriva para mantener la latencia < 60ms
      this.#nextStartTime = now + 0.04;
    }

    source.start(this.#nextStartTime);
    this.#nextStartTime += audioBuffer.duration;
  }
}
