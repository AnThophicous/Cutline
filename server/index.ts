import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import initSqlJs, { type Database } from 'sql.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, createReadStream, createWriteStream } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const require = createRequire(import.meta.url);
const dataDir = process.env.CUTLINE_DATA ?? join(process.cwd(), 'data');
const uploadDir = join(dataDir, 'uploads');
const outputDir = join(dataDir, 'outputs');
mkdirSync(uploadDir, { recursive: true }); mkdirSync(outputDir, { recursive: true });
const dbFile = join(dataDir, 'cutline.sqlite');
type Job = { id: string; kind: string; status: string; progress: number; error?: string };
const jobs: Job[] = [];
let analysisRunning = 0;
let encodeRunning = false;

async function start() {
  const SQL = await initSqlJs({ locateFile: (file) => join(dirname(require.resolve('sql.js')), file) });
  const db: Database = new SQL.Database(existsSync(dbFile) ? readFileSync(dbFile) : undefined);
  db.run(`CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slot TEXT NOT NULL, path TEXT NOT NULL, sha256 TEXT NOT NULL, duration REAL DEFAULT 0, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0, fps TEXT DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cuts (id INTEGER PRIMARY KEY, asset_id TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, intensity TEXT NOT NULL DEFAULT 'natural');
  CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, error TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL);`);
  const persist = () => writeFileSync(dbFile, Buffer.from(db.export())); persist(); setInterval(persist, 5000).unref();
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true, ffmpeg: hasCommand('ffmpeg'), ffprobe: hasCommand('ffprobe'), database: 'sql.js-wasm' }));
  app.post('/api/assets', async (c) => { const form = await c.req.formData(); const file = form.get('file'); if (!(file instanceof File)) return c.json({ error: 'Envie um arquivo no campo file.' }, 400); const id = randomUUID(); const extension = extname(file.name) || '.mp4'; const path = join(uploadDir, `${id}${extension}`); await pipeline(Readable.fromWeb(file.stream() as any), createWriteStream(path)); const hash = await sha256(path); return c.json({ id, name: basename(file.name), path, hash }); });
  app.post('/api/analyze', async (c) => { const body = await c.req.json<{ path?: string; intensity?: string }>(); if (!body.path || !existsSync(body.path)) return c.json({ error: 'Arquivo não encontrado no servidor.' }, 400); if (!hasCommand('ffmpeg')) return c.json({ error: 'FFmpeg não encontrado. Instale FFmpeg para ativar o Smart Cut.' }, 503); const cuts = await detectSilences(body.path, body.intensity ?? 'natural'); return c.json({ path: body.path, cuts }); });
  app.post('/api/cut', async (c) => { const body = await c.req.json<{ path?: string; cuts?: Cut[]; intensity?: string }>(); if (!body.path || !existsSync(body.path)) return c.json({ error: 'Arquivo não encontrado.' }, 400); if (!hasCommand('ffmpeg')) return c.json({ error: 'FFmpeg não encontrado.' }, 503); const output = join(outputDir, `${randomUUID()}${extname(body.path) || '.mp4'}`); const result = await cutWithSyncAudio(body.path, (body.cuts ?? []).filter((cut) => cut.enabled !== false), output); return result.ok ? c.json({ output, cuts: result.cuts }) : c.json({ error: result.error }, 500); });
  app.get('/api/jobs', (c) => c.json(jobs));
  app.post('/api/jobs', async (c) => { const body = await c.req.json<{ kind?: string }>(); const job: Job = { id: randomUUID(), kind: body.kind ?? 'render', status: 'queued', progress: 0 }; jobs.unshift(job); schedule(job); return c.json(job, 202); });
  app.get('/api/events', (c) => { const stream = new ReadableStream({ start(controller) { const send = () => controller.enqueue(`event: jobs\ndata: ${JSON.stringify(jobs)}\n\n`); send(); const timer = setInterval(send, 2000); c.req.raw.signal.addEventListener('abort', () => { clearInterval(timer); controller.close(); }); } }); return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } }); });
  app.get('*', (c) => { const requested = c.req.path === '/' ? 'index.html' : c.req.path.replace(/^\//, ''); const file = join(process.cwd(), 'dist', requested); const fallback = join(process.cwd(), 'dist', 'index.html'); const target = existsSync(file) ? file : fallback; if (!existsSync(target)) return c.text('Frontend não compilado. Execute npm run build.', 503); const extension = target.split('.').pop(); const types: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2' }; return new Response(readFileSync(target), { headers: { 'Content-Type': types[extension ?? ''] ?? 'application/octet-stream' } }); });
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080), hostname: '0.0.0.0' }, (info) => console.log(`Cutline running at http://${info.address}:${info.port}`));
}

type Cut = { start: number; end: number; enabled?: boolean };
const silenceStart = /silence_start:\s*([0-9.]+)/;
const silenceEnd = /silence_end:\s*([0-9.]+)/;
async function detectSilences(path: string, intensity: string): Promise<Cut[]> { const padding = intensity === 'aggressive' ? 0.1 : intensity === 'dynamic' ? 0.18 : 0.28; return new Promise((resolve, reject) => { const child = spawn(ffmpegPath(), ['-hide_banner', '-i', path, '-af', 'silencedetect=noise=-35dB:d=1', '-f', 'null', '-']); let open: number | undefined; let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk.toString(); }); child.on('close', (code) => { if (code !== 0 && !stderr.includes('silence_end')) return reject(new Error(stderr.slice(-500))); const cuts: Cut[] = []; for (const line of stderr.split(/\r?\n/)) { const start = line.match(silenceStart); const end = line.match(silenceEnd); if (start) open = Number(start[1]); if (end && open !== undefined) { const from = open + padding; const to = Number(end[1]) - padding; if (to - from >= 0.45) cuts.push({ start: Number(from.toFixed(3)), end: Number(to.toFixed(3)), enabled: true }); open = undefined; } } resolve(mergeCuts(cuts)); }); child.on('error', reject); }); }
function mergeCuts(cuts: Cut[]) { return cuts.sort((a, b) => a.start - b.start).filter((cut, index) => index === 0 || cut.start - cuts[index - 1].end > 0.35); }
async function duration(path: string) { return new Promise<number>((resolve, reject) => { const child = spawn(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path]); let out = ''; child.stdout.on('data', (chunk) => out += chunk); child.on('close', (code) => code === 0 ? resolve(Number(out.trim())) : reject(new Error('ffprobe falhou'))); child.on('error', reject); }); }
async function cutWithSyncAudio(input: string, cuts: Cut[], output: string) { const total = await duration(input); const segments: Array<[number, number]> = []; let cursor = 0; for (const cut of cuts) { if (cut.start > cursor) segments.push([cursor, cut.start]); cursor = Math.max(cursor, cut.end); } if (cursor < total) segments.push([cursor, total]); if (!segments.length) return { ok: false, error: 'Nenhum trecho de fala foi preservado.' }; const filters = segments.flatMap(([start, end], index) => [`[0:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${index}]`, `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${index}]`]); const concatInputs = segments.map((_, index) => `[v${index}][a${index}]`).join(''); filters.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`); const args = ['-hide_banner', '-y', '-i', input, '-filter_complex', filters.join(';'), '-map', '[outv]', '-map', '[outa]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-movflags', '+faststart', output]; return new Promise<{ ok: boolean; error?: string; cuts: Cut[] }>((resolve) => { const child = spawn(ffmpegPath(), args); let error = ''; child.stderr.on('data', (chunk) => error += chunk.toString()); child.on('close', (code) => resolve(code === 0 ? { ok: true, cuts } : { ok: false, cuts, error: error.slice(-900) })); child.on('error', (err) => resolve({ ok: false, cuts, error: err.message })); }); }
async function sha256(path: string) { const hash = createHash('sha256'); await pipeline(createReadStream(path), hash as any); return hash.digest('hex'); }
function schedule(job: Job) { const isAnalysis = job.kind === 'analysis'; if (isAnalysis && analysisRunning >= 2) return void setTimeout(() => schedule(job), 500); if (!isAnalysis && encodeRunning) return void setTimeout(() => schedule(job), 750); if (isAnalysis) analysisRunning++; else encodeRunning = true; job.status = 'running'; const child = spawn(ffmpegPath(), ['-hide_banner', '-version']); child.on('close', (code) => { job.progress = code === 0 ? 100 : 0; job.status = code === 0 ? 'done' : 'failed'; if (isAnalysis) analysisRunning--; else encodeRunning = false; }); child.on('error', () => { job.status = 'failed'; if (isAnalysis) analysisRunning--; else encodeRunning = false; }); }
function ffmpegPath() { return resolveMediaBinary('ffmpeg'); }
function ffprobePath() { return resolveMediaBinary('ffprobe'); }
function resolveMediaBinary(name: 'ffmpeg' | 'ffprobe') { const candidates = [name, `C:\\ffmpeg\\bin\\${name}.exe`, `C:\\ffmpeg\\bin\\bin\\${name}.exe`]; for (const candidate of candidates) { try { execFileSync(candidate, ['-version'], { stdio: 'ignore' }); return candidate; } catch {} } return name; }
function hasCommand(command: string) { try { execFileSync(command === 'ffmpeg' ? ffmpegPath() : ffprobePath(), ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } }
export function fingerprint(input: Buffer | string, parameters: string) { return createHash('sha256').update(input).update(parameters).digest('hex'); }
export function concatCopyArgs(listFile: string, output: string) { return ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]; }
void start();
