<script lang="ts">
  import { onMount } from 'svelte';
  import { analyzeLocal, concatLocal, cutLocal, localTranscriptionAvailable, transcribeLocal, type LocalCut, type WhisperTier } from './lib/media';

  type View = 'home' | 'project' | 'queue' | 'outputs' | 'settings';
  type EditorTab = 'assembly' | 'cuts' | 'scripts';
  type SlotStatus = 'empty' | 'analyzing' | 'ready' | 'error';
  type Slot = { key: string; label: string; description: string; file?: string; fileObject?: File; path?: string; sourceUrl?: string; cuts: LocalCut[]; duration: number; transcript?: string; headline?: string; status: SlotStatus };
  type Job = { id: string; name: string; status: 'queued' | 'processing' | 'done' | 'failed' | 'cancelled'; progress: number; current?: string; started: number; error?: string };
  type Output = { id: string; name: string; path?: string; blob?: Blob; created: number; combination: string };
  type DeviceProfile = { memoryGb: number; cores: number; tier: 'light' | 'standard' | 'power'; whisper: WhisperTier; nativeApp: boolean; isolated: boolean };

  const createSlots = (): Slot[] => [
    { key: 'H1', label: 'Hooks', description: 'começa a conversa', cuts: [], duration: 0, status: 'empty' },
    { key: 'H2', label: 'Hooks', description: 'segunda abertura', cuts: [], duration: 0, status: 'empty' },
    { key: 'H3', label: 'Hooks', description: 'terceira abertura', cuts: [], duration: 0, status: 'empty' },
    { key: 'C1', label: 'Corpos', description: 'desenvolve a ideia', cuts: [], duration: 0, status: 'empty' },
    { key: 'C2', label: 'Corpos', description: 'segunda versão', cuts: [], duration: 0, status: 'empty' },
    { key: 'CTA1', label: 'CTAs', description: 'fecha o vídeo', cuts: [], duration: 0, status: 'empty' },
    { key: 'CTA2', label: 'CTAs', description: 'segunda finalização', cuts: [], duration: 0, status: 'empty' }
  ];

  let view: View = 'home';
  let editorTab: EditorTab = 'assembly';
  let activeProject = 'Novo projeto';
  let notice = '';
  let smartCut = true;
  let intensity = 'natural';
  let theme = 'violet';
  let slots = createSlots();
  let selectedSlotKey = 'H1';
  let jobs: Job[] = [];
  let outputs: Output[] = [];
  let rendering = false;
  let activeAbort: AbortController | undefined;
  let autoTranscribe = true;
  let transcriptBusy = false;
  let headlineBusy = false;
  let deepseekKey = '';
  let deepseekConsent = false;
  let device: DeviceProfile = { memoryGb: 4, cores: 4, tier: 'standard', whisper: 'tiny', nativeApp: false, isolated: false };

  $: hooks = slots.filter((slot) => slot.label === 'Hooks' && slot.file);
  $: bodies = slots.filter((slot) => slot.label === 'Corpos' && slot.file);
  $: ctas = slots.filter((slot) => slot.label === 'CTAs' && slot.file);
  $: combinations = hooks.length * bodies.length * ctas.length;
  $: selectedSlot = slots.find((slot) => slot.key === selectedSlotKey) ?? slots[0];
  $: transcribedSlots = slots.filter((slot) => slot.transcript);
  $: localProcessing = device.nativeApp;
  $: transcriptionReady = device.whisper && device.isolated;

  onMount(() => {
    const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
    const memoryGb = navigatorWithMemory.deviceMemory ?? 4;
    const cores = navigator.hardwareConcurrency || 4;
    const nativeApp = Boolean((window as Window & { Capacitor?: unknown }).Capacitor) || location.protocol === 'capacitor:';
    const mobileBrowser = /Android|iPhone|iPad/i.test(navigator.userAgent) && window.matchMedia('(pointer: coarse)').matches;
    device = { memoryGb, cores, nativeApp: nativeApp || mobileBrowser, isolated: localTranscriptionAvailable(), tier: memoryGb >= 8 && cores >= 6 ? 'power' : memoryGb >= 6 && cores >= 4 ? 'standard' : 'light', whisper: memoryGb >= 8 && cores >= 6 ? 'small' : 'tiny' };
    deepseekKey = localStorage.getItem('cutline.deepseek.key') ?? '';
    deepseekConsent = localStorage.getItem('cutline.deepseek.consent') === 'true';
    autoTranscribe = localStorage.getItem('cutline.transcription.auto') !== 'false';
    const source = new EventSource('/api/events');
    source.addEventListener('jobs', (event) => { try { const serverJobs = JSON.parse((event as MessageEvent).data) as Job[]; if (serverJobs.length) jobs = jobs.map((job) => serverJobs.find((serverJob) => serverJob.id === job.id) ?? job); } catch {} });
    return () => source.close();
  });

  function notify(message: string) { notice = message; window.setTimeout(() => notice = '', 2600); }
  function updateJob(id: string, patch: Partial<Job>) { jobs = jobs.map((job) => job.id === id ? { ...job, ...patch } : job); }
  function updateSlot(key: string, patch: Partial<Slot>) { slots = slots.map((slot) => slot.key === key ? { ...slot, ...patch } : slot); }
  function createProject() { activeProject = 'Novo projeto'; slots = createSlots(); outputs = []; editorTab = 'assembly'; selectedSlotKey = 'H1'; view = 'project'; notify('Projeto aberto'); }
  function openProject() { view = 'project'; }
  function goSettings() { view = 'settings'; }
  function saveDeepSeek(value: string) { deepseekKey = value; localStorage.setItem('cutline.deepseek.key', value); }
  function setConsent(value: boolean) { deepseekConsent = value; localStorage.setItem('cutline.deepseek.consent', String(value)); }
  function deviceSummary() { return localProcessing ? `local · ${device.memoryGb} GB · ${device.cores} núcleos` : `LAN · ${device.cores} núcleos detectados`; }

  function importError(error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (/file could not be read|code\s*=\s*-?1|não conseguiu ler este vídeo/i.test(message)) {
      return 'O Android não conseguiu ler este vídeo. Tente importar novamente ou escolha um MP4/MOV salvo no aparelho.';
    }
    return message || 'Falha ao analisar este vídeo.';
  }

  async function addFileForSlot(index: number, file: File) {
    if (!file) return;
    const slot = slots[index];
    if (slot.sourceUrl) URL.revokeObjectURL(slot.sourceUrl);
    selectedSlotKey = slot.key;
    updateSlot(slot.key, { file: file.name, fileObject: file, sourceUrl: URL.createObjectURL(file), status: 'analyzing', cuts: [], transcript: undefined, headline: undefined });
    notify(`${file.name}: preparando o editor`);
    try {
      if (localProcessing) {
        const analysis = smartCut ? await analyzeLocal(file, intensity, (progress) => notify(`${file.name}: Smart Cut ${Math.round(progress * 100)}%`)) : { cuts: [], duration: 0 };
        updateSlot(slot.key, { cuts: analysis.cuts, status: 'ready', duration: analysis.duration });
        if (autoTranscribe && transcriptionReady) await transcribeSlot(slot.key, file);
      } else {
        const form = new FormData(); form.append('file', file);
        const upload = await fetch('/api/assets', { method: 'POST', body: form });
        if (!upload.ok) throw new Error('Não foi possível importar este vídeo.');
        const asset = await upload.json();
        let cuts: LocalCut[] = [];
        let duration = 0;
        if (smartCut) {
          const analysis = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: asset.path, intensity }) });
          if (!analysis.ok) throw new Error((await analysis.json()).error ?? 'Smart Cut indisponível.');
          const result = await analysis.json(); cuts = result.cuts ?? []; duration = result.duration ?? 0;
        }
        updateSlot(slot.key, { path: asset.path, cuts, duration, status: 'ready' });
      }
      notify(`${slot.key} pronto${smartCut ? ` · ${slots.find((item) => item.key === slot.key)?.cuts.length ?? 0} pausas tratadas` : ''}`);
    } catch (error) {
      updateSlot(slot.key, { status: 'error' });
      notify(importError(error));
    }
  }

  async function addFile(index: number, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await addFileForSlot(index, file);
  }

  async function addFilesToRole(role: string, event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    const roleSlots = slots.filter((slot) => slot.label === role);
    const emptySlots = roleSlots.filter((slot) => !slot.file);
    const targets = emptySlots.length ? emptySlots : roleSlots;
    const selected = files.slice(0, targets.length);
    for (let index = 0; index < selected.length; index += 1) {
      await addFileForSlot(slots.indexOf(targets[index]), selected[index]);
    }
    if (files.length > selected.length) {
      notify(`${role}: só cabem ${targets.length} vídeos. Os primeiros foram colocados na ordem selecionada.`);
    }
  }

  async function transcribeSlot(key: string, file: File) {
    transcriptBusy = true;
    updateSlot(key, { status: 'analyzing' });
    try {
      const transcript = await transcribeLocal(file, device.whisper, (progress) => notify(`${key}: transcrição local ${Math.round(progress * 100)}%`));
      updateSlot(key, { transcript, status: 'ready' });
    } finally {
      transcriptBusy = false;
    }
  }

  function toggleCut(key: string, index: number) { const slot = slots.find((item) => item.key === key); if (!slot) return; const cuts = slot.cuts.map((cut, cutIndex) => cutIndex === index ? { ...cut, enabled: !cut.enabled } : cut); updateSlot(key, { cuts }); }

  async function render() {
    if (!combinations) return notify('Adicione pelo menos um Hook, um Corpo e um CTA.');
    if (rendering) return;
    rendering = true;
    activeAbort = new AbortController();
    const job: Job = { id: crypto.randomUUID(), name: `${activeProject} · ${combinations} combinações`, status: 'queued', progress: 0, started: Date.now() };
    jobs = [job, ...jobs]; view = 'queue';
    const uniqueSlots = [...hooks, ...bodies, ...ctas];
    const totalSteps = uniqueSlots.length + combinations;
    const processed = new Map<string, Blob | string>();
    let completed = 0;
    try {
      updateJob(job.id, { status: 'processing', current: 'Preparando módulos' });
      for (const slot of uniqueSlots) {
        if (job.status === 'cancelled') throw new Error('Processamento cancelado.');
        updateJob(job.id, { current: `Cortando ${slot.key}`, progress: Math.round((completed / totalSteps) * 100) });
        if (localProcessing && slot.fileObject) {
          processed.set(slot.key, await cutLocal(slot.fileObject, slot.cuts, (progress) => updateJob(job.id, { progress: Math.round(((completed + progress) / totalSteps) * 100) })));
        } else if (slot.path) {
          const response = await fetch('/api/cut', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeAbort.signal, body: JSON.stringify({ path: slot.path, cuts: slot.cuts, intensity }) });
          const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Falha ao cortar o módulo.'); processed.set(slot.key, result.output);
        }
        completed += 1;
      }
      const combinationsList = hooks.flatMap((hook) => bodies.flatMap((body) => ctas.map((cta) => ({ hook, body, cta }))));
      for (const combination of combinationsList) {
        const name = `${combination.hook.key} · ${combination.body.key} · ${combination.cta.key}`;
        updateJob(job.id, { current: `Montando ${name}`, progress: Math.round((completed / totalSteps) * 100) });
        const modules = [processed.get(combination.hook.key), processed.get(combination.body.key), processed.get(combination.cta.key)];
        if (modules.some((module) => !module)) throw new Error(`Módulo ausente em ${name}.`);
        let output: Output;
        if (localProcessing) {
          const blob = await concatLocal(modules as Blob[], (progress) => updateJob(job.id, { progress: Math.round(((completed + progress) / totalSteps) * 100) }));
          output = { id: crypto.randomUUID(), name: `${activeProject} · ${name}`, blob, created: Date.now(), combination: name };
        } else {
          const response = await fetch('/api/concat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeAbort.signal, body: JSON.stringify({ paths: modules }) });
          const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Falha ao montar a combinação.');
          output = { id: crypto.randomUUID(), name: `${activeProject} · ${name}`, path: result.output, created: Date.now(), combination: name };
        }
        outputs = [output, ...outputs]; completed += 1;
      }
      updateJob(job.id, { status: 'done', progress: 100, current: `${combinations} vídeos prontos` });
      notify(`${combinations} combinações concluídas`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') updateJob(job.id, { status: 'cancelled', current: 'Cancelado' });
      else updateJob(job.id, { status: 'failed', current: 'Falha no processamento', error: error instanceof Error ? error.message : 'Falha inesperada.' });
    } finally { rendering = false; activeAbort = undefined; }
  }

  function cancel(id: string) { activeAbort?.abort(); updateJob(id, { status: 'cancelled', current: 'Cancelado' }); rendering = false; }
  function download(output: Output) { if (output.blob) { const url = URL.createObjectURL(output.blob); const link = document.createElement('a'); link.href = url; link.download = `${output.name.replace(/[^a-z0-9À-ÿ]+/gi, '-').toLowerCase()}.mp4`; link.click(); URL.revokeObjectURL(url); } else if (output.path) window.location.href = `/api/files?path=${encodeURIComponent(output.path)}`; }
  async function copyText(value: string) { await navigator.clipboard?.writeText(value); notify('Copiado'); }

  async function generateHeadlines() {
    if (!deepseekKey.trim()) return notify('Adicione a chave DeepSeek em Configurações.');
    if (!deepseekConsent) return notify('Confirme o envio das transcrições em Configurações.');
    const items = slots.filter((slot) => slot.transcript).map((slot) => ({ key: slot.key, module: slot.label, transcript: slot.transcript }));
    if (!items.length) return notify('Transcreva pelo menos um vídeo primeiro.');
    headlineBusy = true;
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey.trim()}` }, body: JSON.stringify({ model: 'deepseek-chat', temperature: 0.72, messages: [
        { role: 'system', content: 'Você é um editor de UGC brasileiro. Crie headlines curtas, naturais e fortes, prontas para acompanhar vídeos. O formato principal deve começar com POV:. Nunca invente fatos que não estejam na transcrição. Evite clickbait mentiroso, emojis, hashtags, frases genéricas e linguagem de agência.' },
        { role: 'user', content: `Para cada item, gere um JSON com key, headline e duas alternativas. A headline principal deve ser um POV específico e conversável, como "POV: você encontrou algo perfeito para resolver isso". Responda somente JSON válido, sem markdown. Itens: ${JSON.stringify(items)}` }
      ] }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? 'A DeepSeek recusou a solicitação.');
      const content = body.choices?.[0]?.message?.content ?? ''; const decoded = JSON.parse(content.replace(/^```json\s*/i, '').replace(/\s*```$/i, '')) as Array<{ key: string; headline: string }> | { items?: Array<{ key: string; headline: string }>; results?: Array<{ key: string; headline: string }> };
      const parsed = Array.isArray(decoded) ? decoded : decoded.items ?? decoded.results ?? [];
      for (const item of parsed) if (item.key && item.headline) updateSlot(item.key, { headline: item.headline });
      notify('Headlines organizadas por vídeo');
    } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível gerar headlines.'); }
    finally { headlineBusy = false; }
  }
</script>

<svelte:head><title>Cutline · Editor inteligente</title><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></svelte:head>

<div class="cutline-app" class:pastel={theme === 'pastel'}>
  <aside class="sidebar">
    <button class="brand" aria-label="Ir para início" on:click={() => view = 'home'}><img src="/cutline-icon.png" alt="" /><span>Cutline</span></button>
    <nav>
      <button class:active={view === 'home'} on:click={() => view = 'home'}><i class="ph ph-house"></i>Início</button>
      <button class:active={view === 'project'} on:click={openProject}><i class="ph ph-film-slate"></i>Editor</button>
      <button class:active={view === 'queue'} on:click={() => view = 'queue'}><i class="ph ph-spinner-gap"></i>Processamento{#if jobs.length}<b class="nav-count">{jobs.length}</b>{/if}</button>
      <button class:active={view === 'outputs'} on:click={() => view = 'outputs'}><i class="ph ph-download-simple"></i>Vídeos prontos{#if outputs.length}<b class="nav-count">{outputs.length}</b>{/if}</button>
      <button class:active={view === 'settings'} on:click={goSettings}><i class="ph ph-sliders-horizontal"></i>Configurações</button>
    </nav>
    <div class="device-note"><i class="ph ph-cpu"></i><div><strong>{localProcessing ? 'Processamento no celular' : 'Processamento na LAN'}</strong><small>{deviceSummary()}</small></div></div>
  </aside>

  <main class="main-content">
    <header class="app-header"><div class="mobile-brand"><img src="/cutline-icon.png" alt="" /> Cutline</div><div class="header-actions"><button class="header-import" on:click={createProject}><i class="ph ph-plus"></i><span>Novo projeto</span></button><button class="theme-button" on:click={() => theme = theme === 'violet' ? 'pastel' : 'violet'} aria-label="Trocar tema"><i class="ph ph-sun"></i></button></div></header>

    {#if view === 'home'}
      <section class="welcome"><div><p class="date-line">editor inteligente</p><h1>O que vamos criar<br />hoje? <i class="ph ph-sparkle still"></i></h1></div><p class="welcome-copy">Corte, organize e multiplique seus vídeos sem perder o ritmo humano.</p></section>
      <button class="create-banner" on:click={createProject}><span class="circle-plus"><i class="ph ph-plus"></i></span><strong>Criar projeto</strong><i class="ph ph-arrow-up-right banner-fluent still"></i></button>
      <section class="smart-overview"><div><p class="date-line">núcleo do editor</p><h2>Mais inteligência. Menos trabalho manual.</h2><p>O Cutline lê pausas, preserva respiros, mantém áudio e vídeo sincronizados e monta sua matriz sem repetir processamento.</p></div><div class="capability-list"><span><i class="ph ph-waveform"></i>Smart Cut humano</span><span><i class="ph ph-microphone"></i>{transcriptionReady ? 'Whisper local pronto' : 'Transcrição sob demanda'}</span><span><i class="ph ph-stack"></i>{outputs.length} vídeos nesta sessão</span></div></section>
      <section class="empty-projects"><div class="empty-icon"><i class="ph ph-scissors"></i></div><h2>Seu próximo vídeo começa aqui</h2><p>Abra um projeto e coloque cada módulo no seu lugar.</p><button class="empty-action" on:click={createProject}>Abrir editor</button></section>
    {:else if view === 'project'}
      <section class="project-view">
        <div class="project-tabs"><div class="project-tab active"><img src="/cutline-icon.png" alt="" />{activeProject}<button class="close-tab" aria-label="Fechar projeto" on:click={() => view = 'home'}><i class="ph ph-x"></i></button></div><button class="add-tab" aria-label="Novo projeto" on:click={createProject}><i class="ph ph-plus"></i></button></div>
        <div class="project-heading"><div><p class="date-line">projeto local <span class="saved-dot"></span></p><h1>Vamos montar seu vídeo <i class="ph ph-sparkle still"></i></h1><p>Coloque Hook, Corpo e CTA. O editor faz o resto.</p></div><button class="render-button" disabled={!combinations || rendering} on:click={render}>{rendering ? 'Processando' : 'Renderizar'} <i class="ph ph-arrow-up-right"></i></button></div>
        <div class="editor-tabs" role="tablist"><button class:active={editorTab === 'assembly'} on:click={() => editorTab = 'assembly'}><i class="ph ph-squares-four"></i>Montagem</button><button class:active={editorTab === 'cuts'} on:click={() => editorTab = 'cuts'}><i class="ph ph-waveform"></i>Smart Cut{#if slots.some((slot) => slot.cuts.length)}<b>{slots.reduce((total, slot) => total + slot.cuts.length, 0)}</b>{/if}</button><button class:active={editorTab === 'scripts'} on:click={() => editorTab = 'scripts'}><i class="ph ph-text-aa"></i>Roteiros{#if transcribedSlots.length}<b>{transcribedSlots.length}</b>{/if}</button></div>
        {#if editorTab === 'assembly'}
          <div class="role-grid">{#each ['Hooks', 'Corpos', 'CTAs'] as role, roleIndex}<section class="role-drop"><div class="role-icon"><i class={`ph ${roleIndex === 0 ? 'ph-anchor' : roleIndex === 1 ? 'ph-play-circle' : 'ph-flag'}`}></i></div><h2>{role}</h2><p>{roleIndex === 0 ? 'O começo que chama atenção' : roleIndex === 1 ? 'A parte que conta a história' : 'O final que convida a agir'}</p><label class="role-import-button"><input type="file" multiple accept="video/*,.mp4,.mov,.m4v" on:change={(event) => addFilesToRole(role, event)} /><i class="ph ph-upload-simple"></i><span>Selecionar {role === 'Hooks' ? 'até 3 vídeos' : 'vários vídeos'}</span></label><div class="role-slots">{#each slots.filter((slot) => slot.label === role) as slot}<label class:file-added={slot.file} class:slot-error={slot.status === 'error'} class="role-slot"><input type="file" accept="video/*,.mp4,.mov,.m4v" on:change={(event) => addFile(slots.indexOf(slot), event)} /><span>{slot.key}</span>{#if slot.file}<strong>{slot.file}</strong><small>{slot.status === 'analyzing' ? 'analisando...' : slot.transcript ? 'transcrito e pronto' : 'vídeo importado'}</small><i class={`ph ${slot.status === 'analyzing' ? 'ph-spinner-gap' : slot.status === 'error' ? 'ph-warning' : 'ph-check'}`}></i>{:else}<strong>Adicionar vídeo</strong><small>{slot.description}</small><b><i class="ph ph-plus"></i></b>{/if}</label>{/each}</div></section>{/each}</div>
          <div class="editor-lower"><section class="preview-panel"><div class="panel-title"><span>Prévia do módulo</span><small>{selectedSlot?.key ?? '—'}</small></div>{#if selectedSlot?.sourceUrl}<video class="video-preview" controls preload="metadata" src={selectedSlot.sourceUrl} on:error={() => notify('A prévia não conseguiu abrir este arquivo. Tente um MP4 ou MOV salvo localmente.')}><track kind="captions" srclang="pt-BR" label="Português" src="data:text/vtt,WEBVTT" /></video>{:else}<div class="preview-empty"><i class="ph ph-play-circle"></i><span>Selecione um vídeo para visualizar</span></div>{/if}<div class="slot-picker">{#each slots as slot}<button class:active={selectedSlotKey === slot.key} disabled={!slot.file} on:click={() => selectedSlotKey = slot.key}>{slot.key}</button>{/each}</div></section><section class="smart-panel"><div class="panel-title"><span>Smart Cut</span><button class="smart-cut-button" class:on={smartCut} on:click={() => smartCut = !smartCut}>{smartCut ? 'Ligado' : 'Desligado'} <span></span></button></div><p>Comprime pausas longas, mantém respiro e evita cortes nervosos.</p><div class="intensity-row"><span>Intensidade</span>{#each [['natural', 'Natural'], ['dynamic', 'Dynamic'], ['aggressive', 'Aggressive']] as option}<button class:active={intensity === option[0]} on:click={() => intensity = option[0]}>{option[1]}</button>{/each}</div><button class="smart-details" on:click={() => editorTab = 'cuts'}>Ver cortes encontrados <i class="ph ph-arrow-right"></i></button></section></div>
        {:else if editorTab === 'cuts'}
          <section class="cuts-workspace"><div class="cut-selector"><span>Escolha um módulo</span><div>{#each slots.filter((slot) => slot.file) as slot}<button class:active={selectedSlotKey === slot.key} on:click={() => selectedSlotKey = slot.key}>{slot.key}</button>{/each}</div></div>{#if selectedSlot?.file}<div class="timeline-card"><div class="panel-title"><div><strong>{selectedSlot.key} · {selectedSlot.file}</strong><small>{selectedSlot.cuts.length} pausas longas encontradas · clique para ativar ou ignorar</small></div><button class="smart-cut-button" class:on={smartCut} on:click={() => smartCut = !smartCut}>{smartCut ? 'Smart Cut ligado' : 'Smart Cut desligado'} <span></span></button></div><div class="timeline"><div class="timeline-speech"></div>{#each selectedSlot.cuts as cut, cutIndex}<button class:disabled={!cut.enabled} class="cut-marker" style={`left:${Math.min(94, (cut.start / Math.max(selectedSlot.duration, cut.end + 1)) * 100)}%;width:${Math.max(2, ((cut.end - cut.start) / Math.max(selectedSlot.duration, cut.end + 1)) * 100)}%`} title={`${cut.start.toFixed(1)}s – ${cut.end.toFixed(1)}s`} on:click={() => toggleCut(selectedSlot.key, cutIndex)}><span>{cut.enabled ? 'comprimir' : 'manter'}</span></button>{/each}</div><div class="timeline-legend"><span><i class="speech-dot"></i>fala preservada</span><span><i class="cut-dot"></i>pausa tratada</span><span>{selectedSlot.duration ? `${selectedSlot.duration.toFixed(1)}s analisados` : 'análise leve de áudio'}</span></div></div>{:else}<div class="empty-projects"><div class="empty-icon"><i class="ph ph-waveform"></i></div><h2>Importe um módulo</h2><p>Os cortes aparecem aqui antes de renderizar.</p><button class="empty-action" on:click={() => editorTab = 'assembly'}>Voltar à montagem</button></div>{/if}</section>
        {:else}
          <section class="scripts-workspace"><div class="scripts-heading"><div><p class="date-line">texto que acompanha o vídeo</p><h2>Roteiros e headlines</h2><p>As transcrições ficam no aparelho. A DeepSeek só recebe o que você aprovar.</p></div><button class="render-button" disabled={headlineBusy || !transcribedSlots.length} on:click={generateHeadlines}>{headlineBusy ? 'Gerando' : 'Gerar headlines'} <i class="ph ph-sparkle"></i></button></div>{#if !transcribedSlots.length}<div class="empty-projects"><div class="empty-icon"><i class="ph ph-microphone-slash"></i></div><h2>Nenhuma transcrição ainda</h2><p>{transcriptionReady ? 'Os vídeos novos serão lidos localmente pelo Whisper.' : 'Ative a transcrição local em um WebView compatível ou use a configuração da DeepSeek.'}</p><button class="empty-action" on:click={() => view = 'settings'}>Abrir configurações</button></div>{:else}<div class="script-grid">{#each slots.filter((slot) => slot.transcript) as slot}<article class="script-card"><div class="script-card-top"><span>{slot.key}</span><small>{slot.label}</small></div><p>{slot.transcript}</p>{#if slot.headline}<div class="headline-result"><small>headline pronta</small><strong>{slot.headline}</strong><button on:click={() => copyText(slot.headline ?? '')}><i class="ph ph-copy"></i> Copiar</button></div>{:else}<small class="headline-empty">Gere headlines para este vídeo quando quiser.</small>{/if}</article>{/each}</div>{/if}</section>
        {/if}
        <div class="project-footer"><div><strong>{combinations ? `${combinations} combinações prontas` : 'A matriz aparece aqui'}</strong><small>{combinations ? 'Cada módulo é processado uma vez e reutilizado.' : 'Adicione pelo menos um vídeo de cada grupo.'}</small></div><button class="smart-cut-button" on:click={() => view = 'settings'}><i class="ph ph-sliders-horizontal"></i> Configurações</button><button class="render-button footer-render" disabled={!combinations || rendering} on:click={render}>{rendering ? 'Processando' : 'Começar'} <i class="ph ph-arrow-up-right"></i></button></div>
      </section>
    {:else if view === 'queue'}
      <section class="queue-view"><div class="section-heading"><div><p class="date-line">atividade em tempo real</p><h1>Processamento</h1><p class="view-copy">Acompanhe módulos e combinações enquanto ficam prontos.</p></div><button class="outline-button" on:click={createProject}><i class="ph ph-plus"></i> Novo projeto</button></div>{#if jobs.length === 0}<div class="empty-projects"><div class="empty-icon"><i class="ph ph-hourglass"></i></div><h2>Nada na fila</h2><p>Quando você iniciar um render, ele aparecerá aqui.</p></div>{:else}<div class="job-grid">{#each jobs as job}<article class:job-done={job.status === 'done'} class:job-failed={job.status === 'failed'} class="job-card"><div class="job-top"><div class="job-status-icon"><i class={`ph ${job.status === 'processing' ? 'ph-spinner-gap' : job.status === 'done' ? 'ph-check-circle' : job.status === 'failed' ? 'ph-warning-circle' : 'ph-clock'}`}></i></div><div><strong>{job.name}</strong><small>{job.current ?? job.status}</small></div><button class="job-cancel" disabled={job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'} on:click={() => cancel(job.id)}>{job.status === 'processing' ? 'Cancelar' : job.status === 'done' ? 'Pronto' : '···'}</button></div><div class="job-progress"><span style={`width:${job.progress}%`}></span></div><div class="job-bottom"><small>{job.progress}% concluído</small><small>{Math.max(0, Math.round((Date.now() - job.started) / 1000))}s</small></div>{#if job.error}<p class="job-error">{job.error}</p>{/if}</article>{/each}</div>{/if}</section>
    {:else if view === 'outputs'}
      <section class="queue-view"><div class="section-heading"><div><p class="date-line">arquivos locais</p><h1>Vídeos prontos</h1><p class="view-copy">Cada combinação está ligada aos três módulos que a criaram.</p></div><button class="outline-button" on:click={() => view = 'project'}><i class="ph ph-film-slate"></i> Voltar ao editor</button></div>{#if outputs.length === 0}<div class="empty-projects"><div class="empty-icon"><i class="ph ph-film-strip"></i></div><h2>Nenhum vídeo pronto</h2><p>Os arquivos aparecem aqui depois do processamento.</p></div>{:else}<div class="job-grid">{#each outputs as output}<article class="job-card output-card"><i class="ph ph-video-camera"></i><div><strong>{output.name}</strong><small>{output.combination} · pronto agora</small></div><button class="outline-button" on:click={() => download(output)}>Baixar <i class="ph ph-download-simple"></i></button></article>{/each}</div>{/if}</section>
    {:else}
      <section class="settings-view"><div class="section-heading"><div><p class="date-line">controle do aparelho e da privacidade</p><h1>Configurações</h1><p class="view-copy">Nada é enviado sem uma ação clara sua.</p></div></div><div class="settings-grid"><section class="settings-panel"><div class="settings-icon"><i class="ph ph-device-mobile"></i></div><h2>Editor local</h2><p>Este aparelho foi identificado como <strong>{device.tier === 'power' ? 'potente' : device.tier === 'standard' ? 'equilibrado' : 'econômico'}</strong>: {device.memoryGb} GB informados, {device.cores} núcleos e {device.isolated ? 'memória compartilhada liberada' : 'memória compartilhada bloqueada'}.</p><div class="device-specs"><span><b>{device.memoryGb} GB</b>RAM estimada</span><span><b>{device.cores}</b>núcleos</span><span><b>{device.whisper}</b>modelo sugerido</span></div><label class="setting-toggle"><input type="checkbox" bind:checked={autoTranscribe} on:change={() => localStorage.setItem('cutline.transcription.auto', String(autoTranscribe))} /><span></span><div><strong>Transcrever vídeos novos</strong><small>{transcriptionReady ? `Whisper ${device.whisper} quantizado roda no aparelho.` : 'Disponível quando o WebView libera memória compartilhada.'}</small></div></label></section><section class="settings-panel deepseek-panel"><div class="settings-icon"><i class="ph ph-key"></i></div><h2>Headlines com DeepSeek</h2><p>A chave fica salva somente neste aparelho. As transcrições só saem daqui quando você confirmar abaixo.</p><label class="field-label" for="deepseek-key">Chave API</label><input id="deepseek-key" type="password" value={deepseekKey} on:input={(event) => saveDeepSeek((event.currentTarget as HTMLInputElement).value)} placeholder="sk-..." autocomplete="off" /><label class="consent-row"><input type="checkbox" checked={deepseekConsent} on:change={(event) => setConsent((event.currentTarget as HTMLInputElement).checked)} /><span>Eu autorizo enviar as transcrições selecionadas para a DeepSeek gerar headlines.</span></label><button class="outline-button" disabled={!deepseekKey || !deepseekConsent} on:click={() => { view = 'project'; editorTab = 'scripts'; generateHeadlines(); }}><i class="ph ph-sparkle"></i> Gerar no editor</button></section></div><div class="audit-note"><i class="ph ph-shield-check"></i><div><strong>Auditoria local ativa</strong><span>Importação, análise, processamento e consentimento ficam registrados nesta sessão. Chaves não aparecem na interface depois de salvas.</span></div></div></section>
    {/if}
  </main>
  <nav class="mobile-nav"><button class:active={view === 'home'} on:click={() => view = 'home'}><i class="ph ph-house"></i><span>Início</span></button><button class:active={view === 'project'} on:click={openProject}><i class="ph ph-film-slate"></i><span>Editor</span></button><button class:active={view === 'queue'} on:click={() => view = 'queue'}><i class="ph ph-spinner-gap"></i><span>Fila</span>{#if jobs.length}<b>{jobs.length}</b>{/if}</button><button class:active={view === 'settings'} on:click={goSettings}><i class="ph ph-sliders-horizontal"></i><span>Ajustes</span></button></nav>
  {#if notice}<div class="toast"><i class="ph ph-sparkle"></i>{notice}</div>{/if}
</div>
