# Remote PC

Cliente de escritorio remoto para `idupi-server`. Vanilla JavaScript (ES Modules), sin frameworks ni bundlers, con un envoltorio Electron opcional para ejecutarse como aplicación nativa en Windows.

## Requisitos

- Node.js 20 o superior.
- Un `idupi-server` accesible (por defecto `http://localhost:8788`) y un Bearer token válido.

## Ejecución

```bash
npm install
npm start        # ventana nativa Electron (pantalla completa automática al conectar)
npm run dev      # igual, con DevTools y F12
npm run serve    # servidor estático en http://localhost:5500 (para navegador)
```

> `src/index.html` usa `<script type="module">`, por lo que debe servirse por HTTP (`npm run serve`) o abrirse desde Electron. Abrirlo con `file://` en un navegador queda bloqueado por CORS.

### Notas de integración

- **Electron y CORS**: la ventana se crea con `webSecurity: false` porque el cliente habla con un `idupi-server` arbitrario (elegido por el usuario) que no responde al preflight de `Authorization: Bearer`. El renderer solo carga contenido local; no ejecuta HTML remoto.
- **Modo navegador**: al servirse por HTTP, el navegador sí aplica CORS. Para usar `npm run serve` el servidor debe responder al preflight `OPTIONS` con `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers: Authorization, Content-Type` y `Access-Control-Allow-Methods`. `npm start` (Electron) no tiene esta limitación.
- **Credenciales**: host, puerto y token se guardan en `localStorage` bajo `idupi.connection.v1`.

## Uso

1. Introduce host, puerto y token. Las credenciales se guardan en `localStorage`.
2. Al conectar se validan `GET /api/v1/screen/config` y `GET /api/v1/screen/monitors`, y arranca el stream del monitor principal.
3. La barra superior aparece al acercar el cursor a los 20 px superiores de la pantalla.

### Atajos

| Atajo | Acción |
| --- | --- |
| `Ctrl` + `Alt` + `1..9` | Cambiar de monitor |
| `F11` | Alternar pantalla completa |
| `Esc` | Salir de pantalla completa o mostrar/ocultar la barra |

## Arquitectura

```
main.mjs            Proceso principal Electron (protocolo idupi://, IPC, fullscreen)
preload.cjs         contextBridge -> window.idupiDesktop
src/
  index.html        Pantalla de conexión + visor
  css/              Tema oscuro (main, connection, viewer)
  js/core/          Store observable y bus de eventos
  js/network/       Cliente HTTP, decodificador binario y consumidor del stream
  js/input/         Ratón y teclado remotos
  js/ui/            Conexión, canvas, barra superior
  js/app.js         Bootstrap y orquestación
```

### Protocolo de frames

Cada mensaje del stream (`application/octet-stream`) se compone de:

```
u32be totalLen | u8 kind | body
  kind 0x4a ('J') -> body = JSON de control (utf-8)
  kind 0x46 ('F') -> body = u32be metaLen | JSON meta (utf-8) | JPEG
```

El servidor es *receiver-paced*: no envía el siguiente frame hasta recibir el ACK del actual (`POST /api/v1/screen/ack`), que se envía tras decodificar y pintar el frame, incluyendo el tiempo de render medido con `performance.now()`.
