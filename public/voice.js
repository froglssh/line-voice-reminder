// 語音對話：瀏覽器直接用 WebSocket 連到 Gemini Live，
// 麥克風聲音送出去、AI 的聲音播出來；AI 要建立提醒時，轉交給我們自己的伺服器處理。

const OUTPUT_RATE = 24000;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export class VoiceSession {
  // callbacks: onState(state, text), onCaption(who, text), onReminderChange(), onError(message)
  constructor(callbacks) {
    this.cb = callbacks;
    this.closed = false;
    this.playing = new Set();
    this.nextPlayTime = 0;
    this.aiText = '';
    this.userText = '';
  }

  // 必須在使用者點擊的當下呼叫（iPhone 規定聲音要由點擊啟動）
  async start() {
    this.cb.onState('connecting', '連線中…');
    this.playCtx = new AudioContext({ sampleRate: OUTPUT_RATE });
    this.micCtx = new AudioContext();
    this.playCtx.resume();
    this.micCtx.resume();

    try {
      const [session, stream] = await Promise.allSettled([
        this.api('/api/voice/session', {}),
        navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
      ]);
      if (stream.status === 'fulfilled') this.stream = stream.value;
      if (stream.status === 'rejected') throw stream.reason;
      if (session.status === 'rejected') throw session.reason;
      if (this.closed) return;
      await this.connect(session.value);
    } catch (err) {
      const msg =
        err.name === 'NotAllowedError'
          ? '沒有麥克風權限，請在瀏覽器設定中允許使用麥克風'
          : err.name === 'NotFoundError'
            ? '找不到麥克風'
            : err.message;
      this.fail(msg);
    }
  }

  async api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '連線失敗');
    return data;
  }

  connect(session) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${session.wsUrl}?access_token=${encodeURIComponent(session.token)}`);
      this.ws = ws;
      let ready = false;

      ws.onopen = () => ws.send(JSON.stringify({ setup: { model: session.model } }));

      ws.onmessage = async (event) => {
        const text = typeof event.data === 'string' ? event.data : await event.data.text();
        let msg;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.setupComplete && !ready) {
          ready = true;
          await this.startMic();
          // 請 AI 先打招呼
          this.send({ realtimeInput: { text: '（使用者剛按下麥克風，請用開場白打招呼）' } });
          this.cb.onState('listening', '我在聽…');
          resolve();
          return;
        }
        this.handle(msg);
      };

      ws.onerror = () => {
        if (!ready) reject(new Error('連不上 Gemini，請稍後再試'));
      };

      ws.onclose = (event) => {
        if (this.closed) return;
        if (!ready) {
          reject(new Error(event.reason ? `Gemini 拒絕連線：${event.reason}` : '連不上 Gemini，請稍後再試'));
          return;
        }
        this.fail(event.code === 1000 ? '對話已結束' : `對話中斷${event.reason ? `：${event.reason}` : ''}`);
      };
    });
  }

  async startMic() {
    await this.micCtx.audioWorklet.addModule('/mic-worklet.js');
    this.source = this.micCtx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.micCtx, 'mic-processor');
    this.worklet.port.onmessage = (e) => {
      this.send({ realtimeInput: { audio: { data: toBase64(e.data), mimeType: 'audio/pcm;rate=16000' } } });
    };
    this.source.connect(this.worklet);
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  handle(msg) {
    const content = msg.serverContent;
    if (content) {
      if (content.interrupted) this.stopPlayback();

      for (const part of content.modelTurn?.parts ?? []) {
        if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
          this.play(part.inlineData.data);
        }
      }
      if (content.inputTranscription?.text) {
        if (this.aiText) this.aiText = '';
        this.userText += content.inputTranscription.text;
        this.cb.onCaption('user', this.userText);
      }
      if (content.outputTranscription?.text) {
        this.userText = '';
        this.aiText += content.outputTranscription.text;
        this.cb.onCaption('ai', this.aiText);
      }
      if (content.turnComplete) {
        this.userText = '';
        this.aiText = '';
      }
    }

    if (msg.toolCall?.functionCalls?.length) this.runTools(msg.toolCall.functionCalls);

    if (msg.goAway) this.cb.onState('listening', '對話時間快到了，再按一次麥克風可以重新開始');
  }

  async runTools(calls) {
    const responses = await Promise.all(
      calls.map(async (call) => {
        let response;
        try {
          response = await this.api('/api/voice/tool', { name: call.name, args: call.args || {} });
        } catch (err) {
          response = { ok: false, error: err.message };
        }
        if (response.ok && call.name !== 'list_reminders') this.cb.onReminderChange(call.name, response);
        return { id: call.id, name: call.name, response };
      }),
    );
    this.send({ toolResponse: { functionResponses: responses } });
  }

  play(b64) {
    const pcm = new Int16Array(fromBase64(b64));
    const buffer = this.playCtx.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const node = this.playCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.playCtx.destination);
    const startAt = Math.max(this.playCtx.currentTime + 0.02, this.nextPlayTime);
    node.start(startAt);
    this.nextPlayTime = startAt + buffer.duration;
    this.playing.add(node);
    this.cb.onState('speaking', '說話中…');
    node.onended = () => {
      this.playing.delete(node);
      if (!this.playing.size && !this.closed) this.cb.onState('listening', '我在聽…');
    };
  }

  stopPlayback() {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {}
    }
    this.playing.clear();
    this.nextPlayTime = 0;
  }

  fail(message) {
    if (this.closed) return;
    this.stop();
    this.cb.onError(message);
  }

  stop() {
    this.closed = true;
    this.stopPlayback();
    try {
      this.ws?.close(1000);
    } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.micCtx?.close().catch(() => {});
    this.playCtx?.close().catch(() => {});
    this.cb.onState('idle', '按一下，用說的建立提醒');
  }
}
