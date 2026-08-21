import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

export type LocalCut = { start: number; end: number; enabled: boolean };
export type WhisperTier = 'tiny' | 'small';

const silenceStart = /silence_start:\s*([0-9.]+)/;
const silenceEnd = /silence_end:\s*([0-9.]+)/;
const modelUrls: Record<WhisperTier, string> = {
  tiny: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny-q5_1.bin',
  small: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin'
};

let ffmpeg: FFmpeg | undefined;
let ffmpegLoad: Promise<FFmpeg> | undefined;

async function getFFmpeg() {
  if (ffmpeg?.loaded) return ffmpeg;
  if (!ffmpegLoad) {
    ffmpegLoad = (async () => {
      const instance = new FFmpeg();
      await instance.load({ coreURL, wasmURL });
      ffmpeg = instance;
      return instance;
    })();
  }
  return ffmpegLoad;
}

function filename(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() || 'mp4';
  return `cutline-input-${crypto.randomUUID()}.${extension}`;
}

function asBytes(value: Uint8Array | string) {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value;
}

async function probeDuration(engine: FFmpeg, input: string) {
  const probe = `cutline-probe-${crypto.randomUUID()}.txt`;
  await engine.ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input, '-o', probe]);
  const value = new TextDecoder().decode(asBytes(await engine.readFile(probe)));
  await engine.deleteFile(probe).catch(() => undefined);
  return Number(value.trim()) || 0;
}

function normalizeCuts(cuts: LocalCut[]) {
  return cuts.sort((a, b) => a.start - b.start).filter((cut, index, all) => index === 0 || cut.start - all[index - 1].end > 0.35);
}

export async function analyzeLocal(file: File, intensity: string, onProgress?: (value: number) => void) {
  const engine = await getFFmpeg();
  const input = filename(file);
  await engine.writeFile(input, await fetchFile(file));
  const logs: string[] = [];
  const listener = ({ message }: { message: string }) => logs.push(message);
  engine.on('log', listener);
  onProgress?.(0.12);
  await engine.exec(['-i', input, '-af', 'silencedetect=noise=-35dB:d=1', '-f', 'null', '-']);
  engine.off('log', listener);
  const padding = intensity === 'aggressive' ? 0.1 : intensity === 'dynamic' ? 0.18 : 0.28;
  let open: number | undefined;
  const cuts: LocalCut[] = [];
  for (const line of logs.join('\n').split(/\r?\n/)) {
    const start = line.match(silenceStart);
    const end = line.match(silenceEnd);
    if (start) open = Number(start[1]);
    if (end && open !== undefined) {
      const from = open + padding;
      const to = Number(end[1]) - padding;
      if (to - from >= 0.45) cuts.push({ start: Number(from.toFixed(3)), end: Number(to.toFixed(3)), enabled: true });
      open = undefined;
    }
  }
  const duration = await probeDuration(engine, input);
  await engine.deleteFile(input).catch(() => undefined);
  onProgress?.(1);
  return { cuts: normalizeCuts(cuts), duration };
}

export async function cutLocal(file: File, cuts: LocalCut[], onProgress?: (value: number) => void) {
  const engine = await getFFmpeg();
  const input = filename(file);
  const output = `cutline-output-${crypto.randomUUID()}.mp4`;
  await engine.writeFile(input, await fetchFile(file));
  const total = await probeDuration(engine, input);
  const segments: Array<[number, number]> = [];
  let cursor = 0;
  for (const cut of cuts.filter((item) => item.enabled !== false)) {
    if (cut.start > cursor) segments.push([cursor, cut.start]);
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < total) segments.push([cursor, total]);
  if (!segments.length) throw new Error('Nenhum trecho de fala foi preservado.');
  const filters = segments.flatMap(([start, end], index) => [
    `[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`,
    `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`
  ]);
  const concatInputs = segments.map((_, index) => `[v${index}][a${index}]`).join('');
  filters.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  const progress = ({ progress: value }: { progress: number }) => onProgress?.(Math.max(0.05, Math.min(0.98, value)));
  engine.on('progress', progress);
  const code = await engine.exec(['-i', input, '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-movflags', '+faststart', output]);
  engine.off('progress', progress);
  if (code !== 0) throw new Error('O FFmpeg local não conseguiu montar este vídeo.');
  const data = asBytes(await engine.readFile(output));
  await engine.deleteFile(input).catch(() => undefined);
  await engine.deleteFile(output).catch(() => undefined);
  onProgress?.(1);
  const blobBytes = new Uint8Array(data.byteLength); blobBytes.set(data);
  return new Blob([blobBytes.buffer], { type: 'video/mp4' });
}

export async function concatLocal(blobs: Blob[], onProgress?: (value: number) => void) {
  const engine = await getFFmpeg();
  const names = blobs.map((_, index) => `cutline-module-${index}-${crypto.randomUUID()}.mp4`);
  const output = `cutline-combination-${crypto.randomUUID()}.mp4`;
  for (let index = 0; index < blobs.length; index += 1) await engine.writeFile(names[index], await fetchFile(blobs[index]));
  const list = `cutline-list-${crypto.randomUUID()}.txt`;
  await engine.writeFile(list, names.map((name) => `file '${name}'`).join('\n'));
  const progress = ({ progress: value }: { progress: number }) => onProgress?.(Math.max(0.05, Math.min(0.98, value)));
  engine.on('progress', progress);
  let code = await engine.exec(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', output]);
  if (code !== 0) code = await engine.exec(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-movflags', '+faststart', output]);
  engine.off('progress', progress);
  if (code !== 0) throw new Error('Não foi possível juntar os módulos desta combinação.');
  const data = asBytes(await engine.readFile(output));
  for (const name of [...names, list, output]) await engine.deleteFile(name).catch(() => undefined);
  onProgress?.(1);
  const blobBytes = new Uint8Array(data.byteLength); blobBytes.set(data);
  return new Blob([blobBytes.buffer], { type: 'video/mp4' });
}

async function cachedModel(url: string, onProgress?: (value: number) => void) {
  if (typeof caches === 'undefined') return new Uint8Array(await (await fetch(url)).arrayBuffer());
  const cache = await caches.open('cutline-whisper-models-v1');
  let response = await cache.match(url);
  if (!response) {
    response = await fetch(url);
    if (!response.ok) throw new Error('Não foi possível baixar o modelo de transcrição.');
    await cache.put(url, response.clone());
  }
  const total = Number(response.headers.get('content-length')) || 1;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const parts: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    parts.push(chunk.value);
    loaded += chunk.value.byteLength;
    onProgress?.(loaded / total);
  }
  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

export function localTranscriptionAvailable() {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
}

export async function transcribeLocal(file: File, tier: WhisperTier, onProgress?: (value: number) => void) {
  if (!localTranscriptionAvailable()) throw new Error('Este aparelho não liberou memória compartilhada para a transcrição local.');
  const engine = await getFFmpeg();
  const input = filename(file);
  const audio = `cutline-audio-${crypto.randomUUID()}.f32`;
  await engine.writeFile(input, await fetchFile(file));
  onProgress?.(0.04);
  const code = await engine.exec(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', audio]);
  if (code !== 0) throw new Error('Não foi possível preparar o áudio para transcrição.');
  const pcmBytes = asBytes(await engine.readFile(audio));
  const pcm = new Float32Array(pcmBytes.buffer.slice(pcmBytes.byteOffset, pcmBytes.byteOffset + pcmBytes.byteLength));
  onProgress?.(0.2);
  const whisperModule = await import('whisper.cpp');
  const factory = whisperModule.default ?? whisperModule;
  const model = await cachedModel(modelUrls[tier], (value) => onProgress?.(0.2 + value * 0.45));
  const modelPath = `cutline-${tier}.bin`;
  const lines: string[] = [];
  const instance = await factory({ print: (line: string) => { if (/-->/.test(line)) lines.push(line.replace(/^.*?\]\s*/, '').trim()); }, printErr: () => undefined });
  instance.FS_createDataFile('/', modelPath, model, true, true);
  if (!instance.init(modelPath)) throw new Error('O modelo Whisper não pôde ser inicializado.');
  instance.full_default(pcm, 'pt', false);
  instance.free();
  await engine.deleteFile(input).catch(() => undefined);
  await engine.deleteFile(audio).catch(() => undefined);
  onProgress?.(1);
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

export { modelUrls };
