// 把麥克風聲音轉成 Gemini 需要的格式：16kHz、單聲道、16-bit PCM，每 100 毫秒送出一包。

class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.chunk = new Int16Array(1600);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // 簡單的降頻：每隔 ratio 個取樣點取一個（取區間平均，減少雜音）
    while (this.pos < input.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(input.length, Math.floor(this.pos + this.ratio));
      let sum = 0;
      for (let i = start; i < Math.max(end, start + 1); i++) sum += input[i];
      const v = sum / Math.max(1, end - start);
      this.chunk[this.filled++] = Math.max(-1, Math.min(1, v)) * 0x7fff;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.filled = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
