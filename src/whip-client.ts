import { StreamConfig, StreamStatus, StreamState, DeviceState, WhipEvent, EventHandler } from './types';

const DEFAULT_API_URL = 'https://back.nexar.com.co';
const DEFAULT_WS_URL = 'wss://back.nexar.com.co';
const DEFAULT_WHIP_PATH = '/rtc/ingest';

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

function _log(debug: boolean, ...args: unknown[]): void {
  if (debug) console.log('[WhipClient]', ...args);
}

export class WhipClient {
  private _config!: StreamConfig;
  private _previewEl!: HTMLVideoElement;

  private _pc: RTCPeerConnection | null = null;
  private _stream: MediaStream | null = null;
  private _ws: WebSocket | null = null;

  private _status: StreamStatus = 'idle';
  private _viewers = 0;
  private _isMuted = true;

  private _videoDevices: MediaDeviceInfo[] = [];
  private _audioDevices: MediaDeviceInfo[] = [];
  private _selectedVideoId = '';
  private _selectedAudioId = '';

  private _pingTimer: ReturnType<typeof setInterval> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private _listeners = new Map<string, EventHandler[]>();

  // ─── Helpers de URL ───
  private get _apiUrl(): string { return this._config.apiUrl ?? DEFAULT_API_URL; }
  private get _wsUrl(): string { return this._config.wsUrl ?? DEFAULT_WS_URL; }
  private get _whipPath(): string { return this._config.whipEndpoint ?? DEFAULT_WHIP_PATH; }
  private get _debug(): boolean { return this._config.debug ?? false; }

  // ═══════════════════════════════════════════
  // Event System
  // ═══════════════════════════════════════════

  on<T extends WhipEvent = WhipEvent>(type: T['type'], fn: EventHandler<T>): void {
    const arr = this._listeners.get(type);
    if (arr) arr.push(fn as EventHandler);
    else this._listeners.set(type, [fn as EventHandler]);
  }

  off<T extends WhipEvent = WhipEvent>(type: T['type'], fn: EventHandler<T>): void {
    const arr = this._listeners.get(type);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === fn) { arr.splice(i, 1); break; }
    }
  }

  private _emit(type: WhipEvent['type'], data: unknown): void {
    const arr = this._listeners.get(type);
    if (!arr) return;
    const evt = { type, data } as WhipEvent;
    for (let i = 0; i < arr.length; i++) arr[i](evt);
  }

  private _setStatus(s: StreamStatus): void {
    this._status = s;
    const state = this._getState();
    this._emit('state', state);
    this._emit('status', s);
    _log(this._debug, 'status →', s);
  }

  private _getState(): StreamState {
    return { status: this._status, viewers: this._viewers, isMuted: this._isMuted };
  }

  // ═══════════════════════════════════════════
  // Init
  // ═══════════════════════════════════════════

  async init(previewElement: HTMLVideoElement, config: StreamConfig): Promise<void> {
    // Token no es requerido en init (se valida en start)
    this._previewEl = previewElement;
    this._config = config;
    this._isMuted = config.startMuted ?? true;

    await this._enumerateDevices();
    await this._initStream();
  }

  /** Actualiza el token en caliente (sin reiniciar dispositivos) */
  setToken(token: string): void {
    this._config.token = token;
    _log(this._debug, 'Token actualizado');
  }

  // ═══════════════════════════════════════════
  // Dispositivos
  // ═══════════════════════════════════════════

  private async _enumerateDevices(): Promise<void> {
    const all = await navigator.mediaDevices.enumerateDevices();

    this._videoDevices = [];
    this._audioDevices = [];
    for (let i = 0; i < all.length; i++) {
      const d = all[i];
      if (d.kind === 'videoinput') this._videoDevices.push(d);
      else if (d.kind === 'audioinput') this._audioDevices.push(d);
    }

    if (this._videoDevices.length && !this._selectedVideoId) {
      this._selectedVideoId = this._videoDevices[0].deviceId;
    }
    if (this._audioDevices.length && !this._selectedAudioId) {
      this._selectedAudioId = this._audioDevices[0].deviceId;
    }

    this._emitDevices();
  }

  private _emitDevices(): void {
    const data: DeviceState = {
      videoDevices: this._videoDevices,
      audioDevices: this._audioDevices,
      selectedVideoId: this._selectedVideoId,
      selectedAudioId: this._selectedAudioId,
    };
    this._emit('devices', data);
  }

  // ═══════════════════════════════════════════
  // Stream local (preview)
  // ═══════════════════════════════════════════

  private async _initStream(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      video: this._selectedVideoId ? { deviceId: { exact: this._selectedVideoId } } : true,
      audio: this._selectedAudioId ? { deviceId: { exact: this._selectedAudioId } } : true,
    };
    this._stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Aplicar mute inicial
    const at = this._stream.getAudioTracks();
    for (let i = 0; i < at.length; i++) {
      at[i].enabled = !this._isMuted;
    }

    this._previewEl.srcObject = this._stream;
  }

  // ═══════════════════════════════════════════
  // Start (HTTP WHIP + WebSocket ICE)
  // ═══════════════════════════════════════════

  async start(): Promise<void> {
    if (this._pc) { _log(this._debug, 'Transmisión ya activa'); return; }
    if (!this._config.token) throw new Error('StreamConfig.token es requerido para iniciar transmisión');
    this._setStatus('connecting');

    try {
      if (!this._stream) await this._initStream();

      // 1. Crear PeerConnection
      this._pc = new RTCPeerConnection({
        iceServers: this._config.iceServers ?? DEFAULT_ICE_SERVERS,
      });

      // 2. Añadir tracks locales
      const tracks = this._stream!.getTracks();
      for (let i = 0; i < tracks.length; i++) {
        this._pc.addTrack(tracks[i], this._stream!);
      }

      // 3. ICE candidate → enviar por WebSocket (cuando esté abierto)
      this._pc.onicecandidate = (e) => {
        if (!e.candidate) {
          _log(this._debug, 'ICE Gathering Complete');
        }
      };

      // 4. ICE connection state → reiniciar si falla
      this._pc.oniceconnectionstatechange = () => {
        const s = this._pc!.iceConnectionState;
        _log(this._debug, 'iceConnectionState →', s);
        if (s === 'disconnected' || s === 'failed') {
          this._restartIce();
        }
      };

      // 5. Crear offer y set local description
      const offer = await this._pc.createOffer();
      await this._pc.setLocalDescription(offer);

      // 6. Aplicar bitrate inicial si está configurado
      this._applyBitrateLimits();

      // 7. Enviar offer al endpoint WHIP (HTTP POST con SDP)
      const whipUrl = `${this._apiUrl}${this._whipPath}`;
      _log(this._debug, 'POST WHIP →', whipUrl);

      const response = await fetch(whipUrl, {
        method: 'POST',
        body: this._pc.localDescription?.sdp,
        headers: {
          'Content-Type': 'application/sdp',
          'Authorization': 'Bananin ' + this._config.token,
        },
      });

      if (!response.ok) {
        throw new Error(`WHIP HTTP error! status: ${response.status}`);
      }

      // 8. Procesar answer del servidor
      const answer = await response.text();
      await this._pc.setRemoteDescription({ type: 'answer', sdp: answer });

      // 9. Conectar WebSocket (ICE + mensajes de aplicación)
      this._connectWS();

      this._setStatus('connected');
      _log(this._debug, 'Transmisión activa');
    } catch (err) {
      _log(this._debug, 'Error en start:', err);
      this._setStatus('error');
      this._emit('error', err instanceof Error ? err : new Error(String(err)));
      this._cleanup();
    }
  }

  // ═══════════════════════════════════════════
  // Stop (HTTP DELETE + cleanup)
  // ═══════════════════════════════════════════

  async stop(): Promise<void> {
    // 1. Eliminar ingest en el backend
    try {
      const deleteUrl = `${this._apiUrl}/rtc/ingest/eliminame`;
      _log(this._debug, 'DELETE →', deleteUrl);
      await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bananin ' + this._config.token,
        },
      });
      _log(this._debug, 'Ingest eliminado');
    } catch (err) {
      _log(this._debug, 'No se pudo eliminar el ingest:', err);
    }

    // 2. Limpiar WS + PC (pero NO el stream local)
    this._cleanup();
    this._setStatus('idle');
  }

  // ═══════════════════════════════════════════
  // Destroy (limpieza total)
  // ═══════════════════════════════════════════

  destroy(): void {
    this._cleanup();

    // Detener tracks del stream local
    if (this._stream) {
      const tracks = this._stream.getTracks();
      for (let i = 0; i < tracks.length; i++) tracks[i].stop();
      this._stream = null;
    }

    // Liberar preview
    if (this._previewEl) this._previewEl.srcObject = null;

    // Limpiar listeners
    this._listeners.clear();

    _log(this._debug, 'destroy completado');
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
      this._reconnectAttempts = 0;
      this._startPing();
    };

    this._ws.onmessage = (evt) => {
      if (typeof evt.data !== 'string') return;

      // Ping interno
      if (evt.data === 'pong') return;

      try {
        const msg = JSON.parse(evt.data);

        if (msg.type === 'ice' && msg.candidate && this._pc) {
          // ICE candidate remoto
          this._pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else if (msg.type === 'viewers') {
          // Actualizar conteo de viewers
          this._viewers = msg.count ?? 0;
          this._emit('state', this._getState());
        } else {
          // Forward de otros mensajes JSON (datos del juego)
          this._emit('message', evt.data);
        }
      } catch {
        // Texto plano → forward
        this._emit('message', evt.data);
      }
    };

    this._ws.onerror = () => {
      _log(this._debug, 'WS error');
      this._setStatus('error');
    };

    this._ws.onclose = () => {
      _log(this._debug, 'WS cerrado');
      if (this._status === 'connected') {
        this._scheduleReconnect();
      }
    };
  }

  private _startPing(): void {
    if (this._pingTimer) clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this._ws?.readyState === WebSocket.OPEN) this._ws.send('ping');
    }, 30000);
  }

  private _reconnectAttempts = 0;
  private _scheduleReconnect(): void {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);

    const base = 1000;
    const max = 30000;
    const delay = Math.min(base * Math.pow(2, this._reconnectAttempts), max);
    this._reconnectAttempts++;

    this._setStatus('reconnecting');
    this._reconnectTimer = setTimeout(() => {
      _log(this._debug, `Intento de reconexión WS #${this._reconnectAttempts} (${delay}ms)...`);
      this._connectWS();
    }, delay);
  }

  private _restartIce(): void {
    if (!this._pc) return;
    _log(this._debug, 'Reiniciando ICE...');
    this._pc.restartIce();
  }

  // ═══════════════════════════════════════════
  // Cleanup (WS + PC, sin tocar stream local)
  // ═══════════════════════════════════════════

  private _cleanup(): void {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._reconnectAttempts = 0;

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

    if (this._pc) {
      this._pc.onicecandidate = null;
      this._pc.oniceconnectionstatechange = null;
      this._pc.close();
      this._pc = null;
    }
  }

  // ═══════════════════════════════════════════
  // Cambio de dispositivo en caliente
  // ═══════════════════════════════════════════

  async changeDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    const constraints = kind === 'videoinput'
      ? { video: { deviceId: { exact: deviceId } } }
      : { audio: { deviceId: { exact: deviceId } } };

    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = newStream.getTracks()[0];
    if (!newTrack) return;

    // 1. Reemplazar en el stream local (SIEMPRE, para el preview)
    const tracks = this._stream?.getTracks();
    if (tracks) {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t.kind === newTrack.kind) {
          t.stop();
          this._stream?.removeTrack(t);
          break;
        }
      }
    }
    this._stream?.addTrack(newTrack);

    // Actualizar selección
    if (kind === 'videoinput') this._selectedVideoId = deviceId;
    else this._selectedAudioId = deviceId;
    this._emitDevices();

    // 2. Reemplazar en peerConnection (solo si hay transmisión activa)
    let sender: RTCRtpSender | undefined;
    const senders = this._pc?.getSenders();
    if (senders) {
      for (let i = 0; i < senders.length; i++) {
        const s = senders[i];
        if (s.track?.kind === newTrack.kind) { sender = s; break; }
      }
    }
    if (sender) {
      await sender.replaceTrack(newTrack);
      _log(this._debug, 'Track reemplazado en PC:', kind);
    }
  }

  // ═══════════════════════════════════════════
  // Bitrate
  // ═══════════════════════════════════════════

  private _applyBitrateLimits(): void {
    const vk = this._config.videoBitrateKbps;
    const ak = this._config.audioBitrateKbps;
    if (!vk && !ak) return;
    if (!this._pc) return;

    const senders = this._pc.getSenders();
    for (let i = 0; i < senders.length; i++) {
      const s = senders[i];
      if (!s.track) continue;
      const params = s.getParameters();
      if (!params.encodings) params.encodings = [{}];
      if (s.track.kind === 'video' && vk) {
        params.encodings[0].maxBitrate = vk * 1000;
      } else if (s.track.kind === 'audio' && ak) {
        params.encodings[0].maxBitrate = ak * 1000;
      }
      s.setParameters(params).catch(function () { /* ignorar */ });
    }
  }

  setBitrate(videoKbps: number, audioKbps: number): void {
    this._config.videoBitrateKbps = videoKbps;
    this._config.audioBitrateKbps = audioKbps;
    this._applyBitrateLimits();
  }

  // ═══════════════════════════════════════════
  // Mute / Unmute
  // ═══════════════════════════════════════════

  mute(): void {
    this._isMuted = true;
    if (this._stream) {
      const at = this._stream.getAudioTracks();
      for (let i = 0; i < at.length; i++) at[i].enabled = false;
    }
    this._emit('state', this._getState());
  }

  unmute(): void {
    this._isMuted = false;
    if (this._stream) {
      const at = this._stream.getAudioTracks();
      for (let i = 0; i < at.length; i++) at[i].enabled = true;
    }
    this._emit('state', this._getState());
  }

  toggleMute(): void {
    if (this._isMuted) this.unmute();
    else this.mute();
  }

  // ═══════════════════════════════════════════
  // Getters de estado
  // ═══════════════════════════════════════════

  get status(): StreamStatus { return this._status; }
  get viewers(): number { return this._viewers; }
  get isMuted(): boolean { return this._isMuted; }
  get stream(): MediaStream | null { return this._stream; }
  get videoDevices(): MediaDeviceInfo[] { return this._videoDevices; }
  get audioDevices(): MediaDeviceInfo[] { return this._audioDevices; }

  sendMessage(data: string): void {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(data);
      _log(this._debug, 'WS send:', data.substring(0, 100));
    } else {
      _log(this._debug, 'WS no disponible para enviar mensaje');
    }
  }
}