export class CanvasView {
  #canvas;
  #ctx;
  #stage;
  #observer;
  #onViewportChange;
  #remoteWidth = 0;
  #remoteHeight = 0;
  #viewportWidth = 0;
  #viewportHeight = 0;
  #hasFrame = false;

  constructor(canvas, { stage, onViewportChange } = {}) {
    this.#canvas = canvas;
    this.#stage = stage;
    this.#onViewportChange = onViewportChange;
    this.#ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.#observer = new ResizeObserver(() => this.fit(true));
    this.#observer.observe(stage);
  }

  get viewport() {
    return { width: this.#viewportWidth, height: this.#viewportHeight };
  }

  setRemoteSize(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    if (w === this.#remoteWidth && h === this.#remoteHeight) return false;

    this.#remoteWidth = w;
    this.#remoteHeight = h;
    this.#canvas.width = w;
    this.#canvas.height = h;
    this.#ctx.imageSmoothingEnabled = true;
    this.#ctx.imageSmoothingQuality = 'high';
    this.fit(false);
    if (!this.#hasFrame) this.clear();
    return true;
  }

  fit(fromStageResize = false) {
    if (!this.#remoteWidth || !this.#remoteHeight) return;

    const stageWidth = this.#stage.clientWidth;
    const stageHeight = this.#stage.clientHeight;
    if (!stageWidth || !stageHeight) return;

    const scale = Math.min(stageWidth / this.#remoteWidth, stageHeight / this.#remoteHeight);
    const width = Math.max(1, Math.floor(this.#remoteWidth * scale));
    const height = Math.max(1, Math.floor(this.#remoteHeight * scale));

    this.#canvas.style.width = `${width}px`;
    this.#canvas.style.height = `${height}px`;

    const changed = width !== this.#viewportWidth || height !== this.#viewportHeight;
    this.#viewportWidth = width;
    this.#viewportHeight = height;

    if (fromStageResize && changed) {
      this.#onViewportChange?.({
        width,
        height,
        remoteWidth: this.#remoteWidth,
        remoteHeight: this.#remoteHeight,
      });
    }
  }

  async renderFrame(meta, jpeg) {
    if (!meta) return;

    const w = Number(meta.w) || 0;
    const h = Number(meta.h) || 0;
    if (w && h) {
      this.setRemoteSize(w, h);
    }

    const ctx = this.#ctx;

    // Manejo de dirty tiles (hito 8): actualización incremental de pantalla
    if (meta.type === 'tiles') {
      const tiles = Array.isArray(meta.tiles) ? meta.tiles : [];
      if (tiles.length === 0 || !jpeg || jpeg.byteLength === 0) {
        // Pantalla sin cambios: frame vacío para telemetría de pacing
        return;
      }

      const tw = Number(meta.tw) || 64;
      const th = Number(meta.th) || 64;
      const cols = Math.ceil((w || this.#remoteWidth || 1920) / tw);

      let offset = 0;
      const tileJobs = [];

      for (const tile of tiles) {
        const len = Number(tile.len);
        if (!len || offset + len > jpeg.byteLength) break;
        const chunk = jpeg.subarray(offset, offset + len);
        offset += len;

        const left = (Number(tile.i) % cols) * tw;
        const top = Math.floor(Number(tile.i) / cols) * th;

        tileJobs.push(
          createImageBitmap(new Blob([chunk], { type: 'image/jpeg' }))
            .then((bmp) => ({ bmp, left, top }))
            .catch((err) => {
              console.warn('[canvas] error al decodificar tile', tile.i, err);
              return null;
            })
        );
      }

      const decoded = await Promise.all(tileJobs);
      for (const item of decoded) {
        if (item?.bmp) {
          ctx.drawImage(item.bmp, item.left, item.top);
          item.bmp.close();
        }
      }
      this.#hasFrame = true;
      return;
    }

    // Keyframe / full JPEG
    if (jpeg && jpeg.byteLength > 0) {
      try {
        const blob = new Blob([jpeg], { type: 'image/jpeg' });
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        this.#hasFrame = true;
      } catch (err) {
        console.error('[canvas] error al decodificar keyframe', err);
      }
    }
  }

  draw(meta, bitmap) {
    if (!bitmap) return;
    const targetWidth = Number(meta?.w) || bitmap.width;
    const targetHeight = Number(meta?.h) || bitmap.height;
    this.setRemoteSize(targetWidth, targetHeight);
    this.#ctx.drawImage(bitmap, 0, 0);
    this.#hasFrame = true;
  }

  clear() {
    this.#ctx.fillStyle = '#05070b';
    this.#ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
    this.#hasFrame = false;
  }

  reset() {
    this.#remoteWidth = 0;
    this.#remoteHeight = 0;
    this.#hasFrame = false;
    this.#ctx.fillStyle = '#05070b';
    this.#ctx.fillRect(0, 0, this.#canvas.width, this.#canvas.height);
  }
}
