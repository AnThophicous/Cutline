<script lang="ts">
  type Cut = { start: number; end: number; enabled?: boolean };
  type Slot = { key: string; label: string; description: string; file?: string; path?: string; cuts?: Cut[] };
  let view: 'home' | 'project' = 'home'; let activeProject = 'Novo projeto'; let notice = ''; let smartCut = true; let theme = 'violet';
  let slots: Slot[] = [
    { key: 'H1', label: 'Hooks', description: 'começa a conversa' }, { key: 'H2', label: 'Hooks', description: 'segunda abertura' }, { key: 'H3', label: 'Hooks', description: 'terceira abertura' },
    { key: 'C1', label: 'Corpos', description: 'desenvolve a ideia' }, { key: 'C2', label: 'Corpos', description: 'segunda versão' },
    { key: 'CTA1', label: 'CTAs', description: 'fecha o vídeo' }, { key: 'CTA2', label: 'CTAs', description: 'segunda finalização' }
  ];
  $: hooks = slots.filter((slot) => slot.label === 'Hooks' && slot.file).length;
  $: bodies = slots.filter((slot) => slot.label === 'Corpos' && slot.file).length;
  $: ctas = slots.filter((slot) => slot.label === 'CTAs' && slot.file).length;
  $: combinations = hooks * bodies * ctas;
  function notify(message: string) { notice = message; setTimeout(() => notice = '', 2300); }
  function createProject() { activeProject = 'Novo projeto'; view = 'project'; notify('Projeto aberto'); }
  async function addFile(index: number, event: Event) { const file = (event.currentTarget as HTMLInputElement).files?.[0]; if (!file) return; slots[index] = { ...slots[index], file: file.name }; slots = [...slots]; notify(`${file.name}: enviando para análise`); const form = new FormData(); form.append('file', file); const upload = await fetch('/api/assets', { method: 'POST', body: form }); if (!upload.ok) return notify('Não foi possível importar este vídeo'); const asset = await upload.json(); const analysis = await fetch('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: asset.path, intensity: 'natural' }) }); if (!analysis.ok) return notify((await analysis.json()).error ?? 'FFmpeg não disponível'); const result = await analysis.json(); slots[index] = { ...slots[index], path: asset.path, cuts: result.cuts }; slots = [...slots]; notify(`${file.name}: ${result.cuts.length} pausas encontradas`); }
  async function render() { if (!combinations) return notify('Adicione Hooks, Corpos e CTAs para continuar'); const ready = slots.filter((slot) => slot.path && slot.cuts?.length); for (const slot of ready) { const response = await fetch('/api/cut', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: slot.path, cuts: slot.cuts, intensity: 'natural' }) }); if (!response.ok) return notify((await response.json()).error ?? 'Falha ao cortar vídeo'); } notify(`${combinations} combinações adicionadas à fila`); }
</script>

<svelte:head><title>Cutline · Criar vídeos</title><meta name="viewport" content="width=device-width, initial-scale=1" /></svelte:head>

<div class="cutline-app" class:pastel={theme === 'pastel'}>
  <aside class="sidebar">
    <button class="brand" aria-label="Ir para início" on:click={() => view = 'home'}><img src="/cutline-icon.png" alt="" /><span>Cutline</span></button>
    <nav><button class:active={view === 'home'} on:click={() => view = 'home'}><i class="ph ph-house"></i>Início</button><button class:active={view === 'project'} on:click={createProject}><i class="ph ph-plus-circle"></i>Novo projeto</button></nav>
    <div class="device-note"><i class="ph ph-device-mobile"></i><div><strong>Processamento local</strong><small>seus vídeos ficam aqui</small></div></div>
  </aside>

  <main class="main-content">
    <header class="app-header"><div class="mobile-brand"><img src="/cutline-icon.png" alt="" /> Cutline</div><div class="header-actions"><button class="header-import" on:click={createProject}><i class="ph ph-plus"></i><span>Começar projeto</span></button><button class="theme-button" on:click={() => theme = theme === 'violet' ? 'pastel' : 'violet'} aria-label="Trocar tema"><i class="ph ph-sun"></i></button></div></header>

    {#if view === 'home'}
      <section class="welcome"><div><p class="date-line">espaço de criação</p><h1>O que vamos criar<br />hoje? <i class="ph ph-sparkle still"></i></h1></div><p class="welcome-copy">Comece um projeto para organizar seus vídeos.</p></section>
      <button class="create-banner" on:click={createProject}><span class="circle-plus"><i class="ph ph-plus"></i></span><strong>Criar projeto</strong><i class="ph ph-sparkle banner-fluent still"></i></button>
      <section class="empty-projects"><div class="empty-icon"><i class="ph ph-folder-plus"></i></div><h2>Nenhum projeto ainda</h2><p>Quando você criar um projeto, ele aparecerá aqui.</p><button class="empty-action" on:click={createProject}>Criar meu primeiro projeto</button></section>
    {:else}
      <section class="project-view">
        <div class="project-tabs"><div class="project-tab active"><img src="/cutline-icon.png" alt="" />{activeProject}<button class="close-tab" aria-label="Fechar projeto" on:click={() => view = 'home'}><i class="ph ph-x"></i></button></div><button class="add-tab" aria-label="Abrir outro projeto" on:click={createProject}><i class="ph ph-plus"></i></button></div>
        <div class="project-heading"><div><p class="date-line">projeto local <span class="saved-dot"></span></p><h1>Vamos montar seu vídeo <i class="ph ph-sparkle still"></i></h1><p>Coloque cada vídeo no seu lugar. É só clicar.</p></div><button class="render-button" on:click={render}>Renderizar <i class="ph ph-arrow-up-right"></i></button></div>
        <div class="role-grid">{#each ['Hooks', 'Corpos', 'CTAs'] as role, roleIndex}<section class="role-drop"><div class="role-icon"><i class={`ph ${roleIndex === 0 ? 'ph-anchor' : roleIndex === 1 ? 'ph-play' : 'ph-flag'}`}></i></div><h2>{role}</h2><p>{roleIndex === 0 ? 'O começo que chama atenção' : roleIndex === 1 ? 'A parte que conta a história' : 'O final que convida a agir'}</p><div class="role-slots">{#each slots.filter((slot) => slot.label === role) as slot}<label class:file-added={slot.file} class="role-slot"><input type="file" accept="video/*" on:change={(event) => addFile(slots.indexOf(slot), event)} /><span>{slot.key}</span>{#if slot.file}<strong>{slot.file}</strong><i class="ph ph-check"></i>{:else}<strong>Adicionar vídeo</strong><small>{slot.description}</small><b><i class="ph ph-plus"></i></b>{/if}</label>{/each}</div></section>{/each}</div>
        <div class="project-footer"><div><strong>{combinations ? `${combinations} combinações prontas` : 'As combinações aparecem aqui'}</strong><small>{combinations ? 'Sem repetir processamento.' : 'Adicione pelo menos um vídeo de cada grupo.'}</small></div><button class="smart-cut-button" class:on={smartCut} on:click={() => smartCut = !smartCut}>Smart Cut {smartCut ? 'ligado' : 'desligado'} <span></span></button><button class="render-button footer-render" disabled={!combinations} on:click={render}>Começar <i class="ph ph-arrow-up-right"></i></button></div>
      </section>
    {/if}
  </main>
  {#if notice}<div class="toast small-toast">{notice}</div>{/if}
</div>
