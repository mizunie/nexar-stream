export interface StreamConfig {
  /** Token Bananin para autenticación (requerido) */
  token: string;
  /** URL base HTTP (default: "https://back.nexar.com.co") */
  apiUrl?: string;
  /** URL base WebSocket (default: "wss://back.nexar.com.co") */
  wsUrl?: string;
  /** Path del endpoint WHIP (default: "/rtc/ingest") */
  whipEndpoint?: string;
  iceServers?: RTCIceServer[];
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  /** Si true, inicia muteado (default: true) */
  startMuted?: boolean;
  /** Si true, logs de depuración en consola */
  debug?: boolean;
}

export type StreamStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'reconnecting';

export interface DeviceState {
  videoDevices: MediaDeviceInfo[];
  audioDevices: MediaDeviceInfo[];
  selectedVideoId: string;
  selectedAudioId: string;
}

export interface StreamState {
  status: StreamStatus;
  viewers: number;
  isMuted: boolean;
}

export type WhipEvent =
  | { type: 'state'; data: StreamState }
  | { type: 'devices'; data: DeviceState }
  | { type: 'message'; data: string }
  | { type: 'error'; data: Error }
  | { type: 'status'; data: StreamStatus };

export type EventHandler<T = WhipEvent> = (event: T) => void;

// ─── WHEP (player) ───

export interface WhepConfig {
  /** Token Bananin para autenticación (requerido) */
  token: string;
  /** URL base HTTP (default: "https://back.nexar.com.co") */
  apiUrl?: string;
  /** URL base WebSocket (default: "wss://back.nexar.com.co") */
  wsUrl?: string;
  /** Path del endpoint WHEP (default: "/rtc/play") */
  whepEndpoint?: string;
  iceServers?: RTCIceServer[];
  /** Si true, logs de depuración en consola */
  debug?: boolean;
}

export type WhepStatus = 'idle' | 'connecting' | 'connected' | 'playing' | 'error' | 'reconnecting';

export interface WhepState {
  status: WhepStatus;
  viewers: number;
  isLive: boolean;
}

export type WhepEvent =
  | { type: 'state'; data: WhepState }
  | { type: 'message'; data: Record<string, any> }
  | { type: 'error'; data: Error }
  | { type: 'status'; data: WhepStatus };