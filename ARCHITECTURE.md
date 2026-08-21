# Cutline — arquitetura curta

Cutline é um processo Node/Hono que serve a SPA Svelte e uma API HTTP local. O estado persistente fica em SQLite via `sql.js`/WebAssembly, sem Python, Visual C++ ou bindings nativos; o snapshot é salvo em `data/cutline.sqlite`. Arquivos e artefatos ficam em diretórios de dados no disco. O backend controla `ffprobe`/`ffmpeg` via subprocessos e nunca carrega vídeos inteiros em memória.

## Modelo de dados

- `projects(id, name, created_at, updated_at)`
- `assets(id, project_id, slot, path, sha256, duration, width, height, fps, created_at)`
- `cuts(id, asset_id, start, end, enabled, intensity)`
- `jobs(id, project_id, kind, status, progress, error, created_at, updated_at)`
- `outputs(id, project_id, job_id, path, fingerprint, created_at)`

## Pipeline

1. Upload para `data/projects/<id>/source` em streaming.
2. SHA-256 + `ffprobe` registram o módulo e alimentam o cache.
3. Smart Cut usa `ffmpeg -af silencedetect` e heurísticas de duração, respiro e distância mínima; os trechos ficam editáveis antes do job. No APK o mesmo pipeline usa FFmpeg WASM.
4. Cada módulo aprovado vira um intermediário cacheado por hash + parâmetros. A concatenação também é cacheada por lista ordenada de módulos.
5. As combinações são geradas por matriz H × C × CTA. O worker tenta concatenação `-c copy`; só usa reencode quando a cópia falha.
6. Em aparelhos compatíveis, o áudio é extraído a 16 kHz e transcrito localmente com Whisper.cpp WASM e modelo GGML quantizado. O modelo é selecionado pelo perfil de memória/CPU e armazenado no cache do aparelho.
7. Headlines são opcionais: a chave DeepSeek é guardada localmente, o consentimento é explícito e somente texto de transcrição é enviado à API.
6. Scheduler limita análise a 2–3 workers e encode a 1 worker em máquinas pequenas. Jobs expõem eventos por SSE.

O MVP implementado já contém a base do servidor, persistência, fila limitada e uma dashboard Svelte mobile-first. O pipeline FFmpeg está isolado em `internal/media` para crescer sem espalhar comandos pelo código HTTP.
