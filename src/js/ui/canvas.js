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

  draw(meta, bitmap) {
    if (!bitmap) return;

    const targetWidth = Number(meta?.w) || bitmap.width;
    const targetHeight = Number(meta?.h) || bitmap.height;
    const resized = this.setRemoteSize(targetWidth, targetHeight);
    const ctx = this.#ctx;

    let drawn = false;
    const tiles = Array.isArray(meta?.tiles) ? meta.tiles : null;
    const isFullFrame = bitmap.width === this.#remoteWidth && bitmap.height === this.#remoteHeight;

    if (!resized && tiles?.length && !isFullFrame) {
      for (const tile of tiles) {
        if (!tile) continue;
        const tileWidth = Number(tile.w) || bitmap.width;
        const tileHeight = Number(tile.h) || bitmap.height;
        if (tileWidth !== bitmap.width || tileHeight !== bitmap.height) continue;
        ctx.drawImage(bitmap, Math.round(tile.x) || 0, Math.round(tile.y) || 0);
        drawn = true;
      }
    }

    if (!drawn) ctx.drawImage(bitmap, 0, 0);
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
