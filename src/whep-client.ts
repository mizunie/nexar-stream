import type { WhepConfig, WhepStatus, WhepState, WhepEvent, EventHandler } from './types';

const DEFAULT_API_URL = 'https://back.nexar.com.co';
const DEFAULT_WS_URL = 'wss://back.nexar.com.co';
const DEFAULT_WHEP_PATH = '/rtc/play';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

function _log(debug: boolean, ...args: unknown[]): void {
  if (debug) console.log('[WhepClient]', ...args);
}

export class WhepClient {
  private _config!: WhepConfig;
  private _videoEl!: HTMLVideoElement;

  private _pc: RTCPeerConnection | null = null;
  private _ws: WebSocket | null = null;

  private _status: WhepStatus = 'idle';
  private _viewers = 0;

  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private _listeners = new Map<string, EventHandler[]>();

  // ─── Helpers ───
  private get _apiUrl(): string { return this._config.apiUrl ?? DEFAULT_API_URL; }
  private get _wsUrl(): string { return this._config.wsUrl ?? DEFAULT_WS_URL; }
  private get _whepPath(): string { return this._config.whepEndpoint ?? DEFAULT_WHEP_PATH; }
  private get _debug(): boolean { return this._config.debug ?? false; }

  // ═══════════════════════════════════════════
  // Event System
  // ═══════════════════════════════════════════

  on<T extends WhepEvent = WhepEvent>(type: T['type'], fn: EventHandler<T>): void {
    const arr = this._listeners.get(type);
    if (arr) arr.push(fn as EventHandler);
    else this._listeners.set(type, [fn as EventHandler]);
  }

  off<T extends WhepEvent = WhepEvent>(type: T['type'], fn: EventHandler<T>): void {
    const arr = this._listeners.get(type);
    if (!arr) return;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] === fn) { arr.splice(i, 1); break; }
    }
  }

  private _emit(type: WhepEvent['type'], data: unknown): void {
    const arr = this._listeners.get(type);
    if (!arr) return;
    const evt = { type, data } as any;
    for (let i = 0; i < arr.length; i++) arr[i](evt);
  }

  private _setStatus(s: WhepStatus): void {
    this._status = s;
    const state = this._getState();
    this._emit('state', state);
    this._emit('status', s);
    _log(this._debug, 'status →', s);
  }

  private _getState(): WhepState {
    return { status: this._status, viewers: this._viewers, isLive: this._status === 'playing' };
  }

  // ═══════════════════════════════════════════
  // API pública
  // ═══════════════════════════════════════════

  /** Conecta WebSocket. El WHEP (WebRTC) se dispara automáticamente al recibir status "live". */
  connect(token: string, videoEl: HTMLVideoElement, config?: WhepConfig): void {
    this._config = config ?? {} as WhepConfig;
    this._config.token = token;
    this._videoEl = videoEl;
    this._setStatus('connecting');
    this._connectWS();
  }

  /** Cierra WS + PC y resetea estado */
  disconnect(): void {
    this._cleanup();
    this._setStatus('idle');
    this._viewers = 0;
  }

  /** Envía datos crudos por WebSocket (ej: "gane|123") */
  send(data: string): void {
    if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(data);
  }

  // ═══════════════════════════════════════════
  // WebSocket
  // ═══════════════════════════════════════════

  private _connectWS(): void {
    const url = `${this._wsUrl}/ws/rtc?token=${this._config.token}`;
    _log(this._debug, 'WS connect →', url);
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      _log(this._debug, 'WS abierto');
      this._setStatus('connected');
      this._startPing();
    };

    this._ws.onmessage = (evt) => {
      if (typeof evt.data !== 'string') return;
      if (evt.data === 'pong') return;

      try {
        const data = JSON.parse(evt.data);
        this._emit('message', data);

        if (data.status === 'live') {
          this._setStatus('playing');
          this._loadStream();
        } else if (data.status === 'ended') {
          this._setStatus('connected');
        } else if (data.status === 'info' && data.viewers !== undefined) {
          this._viewers = data.viewers as number;
          this._emit('state', this._getState());
        }
      } catch { /* ignorar */ }
    };

    this._ws.onerror = () => {
      _log(this._debug, 'WS error');
      this._setStatus('error');
      this._scheduleReconnect();
    };

    this._ws.onclose = () => {
      _log(this._debug, 'WS cerrado');
      this._stopPing();
      if (this._status !== 'idle') this._scheduleReconnect();
    };
  }

  // ═══════════════════════════════════════════
  // WHEP (WebRTC player — recibe stream)
  // ═══════════════════════════════════════════

  private async _loadStream(user: string | null = null, pass: string | null = null): Promise<void> {
    if (!this._videoEl) return;

    const resourceUrl = `${this._apiUrl}${this._whepPath}`;
    const iceServers = (user && pass) ? [
      {
        urls: [
          'stun:stun.cloudflare.com:3478',
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:3478?transport=tcp',
          'turns:turn.cloudflare.com:5349?transport=tcp',
        ],
        username: user,
        credential: pass,
      },
    ] : this._config.iceServers ?? DEFAULT_ICE_SERVERS;

    try {
      if (this._pc) { this._pc.close(); this._pc = null; }

      this._pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

      const remoteTracksPromise = new Promise<MediaStreamTrack[]>((resolve) => {
        const tracks: MediaStreamTrack[] = [];
        this._pc!.ontrack = (event) => {
          tracks.push(event.track);
          if (tracks.length >= 2) resolve(tracks);
        };
        setTimeout(() => resolve(tracks), 5000);
      });

      // POST → obtener offer
      const offerResp = await fetch(resourceUrl, {
        method: 'POST',
        headers: { Authorization: `Bananin ${this._config.token}` },
      });

      if (!offerResp.ok) {
        const errText = await offerResp.text();
        throw new Error(errText);
      }

      const offerSdp = await offerResp.text();
      await this._pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);

      // PATCH → enviar answer
      const location = offerResp.headers.get('location');
      if (!location) throw new Error('Falta header location');

      const sessionUrl = new URL(location, resourceUrl);
      await fetch(sessionUrl.toString(), {
        method: 'PATCH',
        body: answer.sdp,
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: `Bananin ${this._config.token}`,
        },
      });

      // Asignar stream al <video>
      const remoteTracks = await remoteTracksPromise;
      if (remoteTracks.length === 0) {
        _log(this._debug, 'No se recibieron tracks remotos');
        return;
      }
      const stream = new MediaStream();
      for (let i = 0; i < remoteTracks.length; i++) stream.addTrack(remoteTracks[i]);
      this._videoEl.srcObject = stream;
      await this._videoEl.play();
      _log(this._debug, 'Stream reproduciendo');
    } catch (err) {
      console.error('[WhepClient] Error en WHEP:', err);
      this._emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ═══════════════════════════════════════════
  // Keep-alive + Reconexión
  // ═══════════════════════════════════════════

  private _startPing(): void {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) this._ws.send('ping');
    }, 30000);
  }

  private _stopPing(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._setStatus('reconnecting');
    this._reconnectTimer = setTimeout(() => {
      _log(this._debug, 'Reconectando...');
      this._connectWS();
    }, 5000);
  }

  // ═══════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════

  private _cleanup(): void {
    this._stopPing();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }

    if (this._ws) {
      this._ws.onopen = null;
      this._ws.onmessage = null;
      this._ws.onerror = null;
      this._ws.onclose = null;
      if (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING) {
        this._ws.close();
      }
      this._ws = null;
    }

    if (this._pc) { this._pc.close(); this._pc = null; }
  }

  // ═══════════════════════════════════════════
  // Getters
  // ═══════════════════════════════════════════

  get status(): WhepStatus { return this._status; }
  get viewers(): number { return this._viewers; }
  get isLive(): boolean { return this._status === 'playing'; }
}