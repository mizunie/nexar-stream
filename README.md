# @nexar/stream

Librería **cero dependencias, sin framework** para transmisión de video/audio vía WebRTC (WHIP) y para reproducir streams (WHEP).

Funciona con vanilla JS, React, Vue, Angular, Svelte o cualquier runtime de navegador.

---

## Instalación

```bash
pnpm add @nexar/stream
```

---

## WHIP (transmisor) – Uso rápido

```typescript
import { WhipClient } from "@nexar/stream";

const client = new WhipClient();

// 1. Inicializar (enumera dispositivos, crea stream local, muestra preview)
await client.init(
  document.getElementById("preview") as HTMLVideoElement,
  {
    token: "tu-token-bananin",
    // apiUrl y wsUrl son opcionales, por defecto:
    // apiUrl: "https://back.nexar.com.co"
    // wsUrl:  "wss://back.nexar.com.co"
  }
);

// 2. Escuchar eventos
client.on("state", (e) => console.log("Estado:", e.data));
client.on("message", (e) => console.log("Mensaje:", e.data));

// 3. Iniciar transmisión
await client.start();

// 4. Cambiar cámara en caliente
await client.changeDevice("videoinput", "id-del-dispositivo");

// 5. Detener
await client.stop();

// 6. Destruir todo
client.destroy();
```

### Flujo WHIP

| Paso | Protocolo | Endpoint |
|---|---|---|
| Enviar offer (SDP) | HTTP POST | `{apiUrl}/rtc/ingest` |
| Recibir answer (SDP) | HTTP Response | — |
| ICE candidates | WebSocket | `{wsUrl}/ws/rtc?token={token}` |
| Mensajes de aplicación | WebSocket | — |
| Eliminar ingest | HTTP DELETE | `{apiUrl}/rtc/ingest/eliminame` |
| Ping keep-alive | WebSocket | `"ping"` |

---

## WHEP (reproductor) – Uso rápido

```typescript
import { WhepClient } from "@nexar/stream";

const player = new WhepClient();

// Escuchar mensajes que llegan del WebSocket
player.on("message", (e) => {
  console.log("Mensaje del backend:", e.data);
  // e.data puede contener { status: 'live', viewers, ... }
});

// Conectar: WebSocket y cargar stream automáticamente cuando llegue "live"
player.connect("tu-token-bananin", document.getElementById("remoteVideo") as HTMLVideoElement, {
  debug: true
});

// Enviar datos al backend
player.send("gane|123");

// Estado
console.log(player.status);  // 'connected', 'playing', etc.

// Cerrar
player.disconnect();
```

### Flujo WHEP

| Paso | Protocolo | Endpoint |
|---|---|---|
| Conectar WebSocket | WebSocket | `{wsUrl}/ws/rtc?token={token}` |
| Recibir mensaje `"live"` | WebSocket | (dispara WHEP) |
| Obtener offer (SDP) | HTTP POST | `{apiUrl}/rtc/play` |
| Enviar answer (SDP) | HTTP PATCH | `{apiUrl}/rtc/play/{sessionId}` (del header `location`) |
| Reproducir stream | WebRTC | — |
| Ping keep-alive | WebSocket | `"ping"` cada 30s |
| Reconexión automática | WebSocket | si se cae, reintenta cada 5s |

---

## API – WHIP (`WhipClient`)

### `new WhipClient()`
Crea una instancia. Sin parámetros.

### `client.init(previewElement, config)`
Inicializa el cliente: enumera cámaras y micrófonos, crea el `MediaStream` local y lo asigna al elemento `<video>`.

| Parámetro | Tipo | Descripción |
|---|---|---|
| `previewElement` | `HTMLVideoElement` | Elemento `<video>` donde se mostrará el preview local |
| `config` | `StreamConfig` | Configuración de conexión |

**`StreamConfig`**

| Propiedad | Tipo | Default | Descripción |
|---|---|---|---|
| `token` | `string` | — | **Requerido.** Token Bananin |
| `apiUrl` | `string` | `"https://back.nexar.com.co"` | URL base HTTP |
| `wsUrl` | `string` | `"wss://back.nexar.com.co"` | URL base WebSocket |
| `whipEndpoint` | `string` | `"/rtc/ingest"` | Path del endpoint WHIP |
| `iceServers` | `RTCIceServer[]` | STUN (Cloudflare, Google, Twilio) | Servidores ICE |
| `videoBitrateKbps` | `number` | — | Bitrate de video en kbps |
| `audioBitrateKbps` | `number` | — | Bitrate de audio en kbps |
| `startMuted` | `boolean` | `true` | Si inicia con micrófono muteado |
| `debug` | `boolean` | `false` | Si `true`, logs `[WhipClient]` en consola |

### `client.start()`
Crea `RTCPeerConnection`, envía offer SDP, recibe answer, abre WebSocket para ICE y mensajes. Emite `"connecting"` → `"connected"`.

### `client.stop()`
Hace HTTP DELETE a `{apiUrl}/rtc/ingest/eliminame`, cierra WS y PC. El stream local y listeners no se destruyen.

### `client.destroy()`
Limpia todo: tracks del stream local, WS, PC, listeners.

### `client.changeDevice(kind, deviceId)`
Cambia cámara o micrófono sin cortar transmisión.

| Parámetro | Tipo | Descripción |
|---|---|---|
| `kind` | `"videoinput"` \| `"audioinput"` | Tipo de dispositivo |
| `deviceId` | `string` | ID del dispositivo |

### `client.mute()` / `client.unmute()` / `client.toggleMute()`
Controla el audio local (`track.enabled`). Emite `"state"`.

### `client.setBitrate(videoKbps, audioKbps)`
Ajusta bitrate máximo de los tracks enviados.

### Eventos WHIP

| Evento | Payload | ¿Cuándo? |
|---|---|---|
| `"state"` | `StreamState` | Cambios de estado, viewers, mute |
| `"devices"` | `DeviceState` | Al enumerar o cambiar dispositivo |
| `"message"` | `string` | Mensajes del WebSocket |
| `"error"` | `Error` | Errores de conexión |
| `"status"` | `StreamStatus` | Solo el cambio de estado |

**`StreamStatus`**: `"idle"` | `"connecting"` | `"connected"` | `"error"` | `"reconnecting"`

**`StreamState`**: `{ status: StreamStatus; viewers: number; isMuted: boolean }`

**`DeviceState`**: `{ videoDevices: MediaDeviceInfo[]; audioDevices: MediaDeviceInfo[]; selectedVideoId: string; selectedAudioId: string }`

### Getters WHIP

| Getter | Tipo | Descripción |
|---|---|---|
| `status` | `StreamStatus` | Estado actual |
| `viewers` | `number` | Cantidad de viewers |
| `isMuted` | `boolean` | Si el audio está muteado |
| `stream` | `MediaStream \| null` | Stream local |
| `videoDevices` | `MediaDeviceInfo[]` | Cámaras disponibles |
| `audioDevices` | `MediaDeviceInfo[]` | Micrófonos disponibles |

---

## API – WHEP (`WhepClient`)

### `new WhepClient()`
Crea una instancia. Sin parámetros.

### `player.connect(token, videoElement, config?)`
Conecta el WebSocket con el token dado y, ante señal `"live"`, inicia el WebRTC para reproducir.

| Parámetro | Tipo | Descripción |
|---|---|---|
| `token` | `string` | Token Bananin (requerido) |
| `videoElement` | `HTMLVideoElement` | Elemento `<video>` donde se mostrará el stream remoto |
| `config` | `WhepConfig` | (opcional) Configuración adicional |

**`WhepConfig`**

| Propiedad | Tipo | Default | Descripción |
|---|---|---|---|
| `token` | `string` | (se pasa en `connect`) | **Requerido.** Token Bananin |
| `apiUrl` | `string` | `"https://back.nexar.com.co"` | URL base HTTP |
| `wsUrl` | `string` | `"wss://back.nexar.com.co"` | URL base WebSocket |
| `whepEndpoint` | `string` | `"/rtc/play"` | Path del endpoint WHEP |
| `iceServers` | `RTCIceServer[]` | STUN (Cloudflare, Google, Twilio) | Servidores ICE |
| `debug` | `boolean` | `false` | Si `true`, logs `[WhepClient]` en consola |

### `player.disconnect()`
Cierra WebSocket, PeerConnection y resetea el estado.

### `player.send(data)`
Envía una cadena por el WebSocket (ej: `"gane|idJuego"`).

### Eventos WHEP

| Evento | Payload | ¿Cuándo? |
|---|---|---|
| `"state"` | `WhepState` | Cambios de estado |
| `"message"` | `Record<string, any>` | Cada mensaje JSON del WebSocket |
| `"error"` | `Error` | Errores de conexión WHEP |
| `"status"` | `WhepStatus` | Solo el cambio de estado |

**`WhepStatus`**: `"idle"` | `"connecting"` | `"connected"` | `"playing"` | `"error"` | `"reconnecting"`

**`WhepState`**: `{ status: WhepStatus; viewers: number; isLive: boolean }`

### Getters WHEP

| Getter | Tipo | Descripción |
|---|---|---|
| `status` | `WhepStatus` | Estado actual |
| `viewers` | `number` | Número de viewers |
| `isLive` | `boolean` | `true` si status es `"playing"` |

---

## Integración con frameworks

### Angular (wrapper con Signals) – WHIP

```typescript
// stream.service.ts
import { Injectable, signal, computed } from "@angular/core";
import { WhipClient, type StreamStatus } from "@nexar/stream";

@Injectable({ providedIn: "root" })
export class StreamService {
  private _client = new WhipClient();

  readonly status = signal<StreamStatus>("idle");
  readonly isMuted = signal(true);
  readonly viewers = signal(0);
  readonly isConnected = computed(() => this.status() === "connected");

  constructor() {
    this._client.on("state", (e) => {
      this.status.set(e.data.status);
      this.viewers.set(e.data.viewers);
      this.isMuted.set(e.data.isMuted);
    });
  }

  init(el: HTMLVideoElement, cfg: StreamConfig) { return this._client.init(el, cfg); }
  start() { return this._client.start(); }
  stop() { return this._client.stop(); }
  destroy() { this._client.destroy(); }
  changeDevice(k: "audioinput" | "videoinput", id: string) { return this._client.changeDevice(k, id); }
  mute() { this._client.mute(); }
  unmute() { this._client.unmute(); }
  onMessage(fn: (msg: string) => void) { this._client.on("message", (e) => fn(e.data)); }
}
```

### Angular (wrapper con Signals) – WHEP

```typescript
// whep.service.ts
import { Injectable, signal } from "@angular/core";
import { Subject } from "rxjs";
import { WhepClient } from "@nexar/stream";

@Injectable({ providedIn: "root" })
export class WhepService {
  private _client = new WhepClient();

  readonly streamState = signal<number>(2);
  readonly viewers = signal<number>(0);
  readonly isConnected = signal<boolean>(false);
  readonly messages$ = new Subject<any>();

  constructor() {
    this._client.on("message", (e) => {
      const data = e.data;
      this.messages$.next(data);
      if (data.status === "live") this.streamState.set(1);
      else if (data.status === "ended") this.streamState.set(2);
      if (data.viewers != null) this.viewers.set(data.viewers);
    });
    this._client.on("status", (e) => {
      this.isConnected.set(e.data === "connected" || e.data === "playing");
    });
  }

  connect(token: string, videoEl: HTMLVideoElement, resourceUrl?: string) {
    this._client.connect(token, videoEl, {
      whepEndpoint: resourceUrl ? new URL(resourceUrl).pathname : undefined,
    });
  }

  disconnect() { this._client.disconnect(); }
  send(data: string) { this._client.send(data); }
}
```

### React (hook) – WHIP

```tsx
import { useRef, useState, useEffect } from "react";
import { WhipClient, type StreamConfig } from "@nexar/stream";

export function useStream(previewRef: React.RefObject<HTMLVideoElement>, config: StreamConfig) {
  const [status, setStatus] = useState("idle");
  const clientRef = useRef(new WhipClient());

  useEffect(() => {
    const c = clientRef.current;
    c.on("state", (e) => setStatus(e.data.status));
    c.init(previewRef.current!, config);
    return () => c.destroy();
  }, []);

  return { client: clientRef.current, status };
}
```

### React (hook) – WHEP

```tsx
import { useRef, useState, useEffect } from "react";
import { WhepClient } from "@nexar/stream";

export function useWhepPlayer(token: string) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState("idle");
  const clientRef = useRef(new WhepClient());

  useEffect(() => {
    const client = clientRef.current;
    client.on("status", (e) => setStatus(e.data));
    if (videoRef.current) client.connect(token, videoRef.current);
    return () => client.disconnect();
  }, [token]);

  return { videoRef, status, send: (data: string) => clientRef.current.send(data) };
}
```

---

## Soporte de runtime

| Runtime | Soporte |
|---|---|
| Chrome, Edge, Brave | ✅ Completo |
| Firefox | ✅ Completo |
| Safari | ✅ Completo |
| Node.js | ❌ (usa APIs del navegador) |
| Deno | ❌ |
| Bun | ❌ |

---

## Licencia

ISC