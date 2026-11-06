'use strict';
/* UrbanClin — interface web (SPA sem build). */

/* ================================================================== */
/* Utilidades                                                           */
/* ================================================================== */

const S = { token: null, me: null, charts: [] };
try { S.token = localStorage.getItem('uc_token'); } catch { /* sem storage */ }

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const digits = (s) => String(s || '').replace(/\D/g, '');
const fmtData = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—');
const fmtMoeda = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtCPF = (s) => digits(s).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const fmtCNPJ = (s) => (digits(s).length === 11
  ? digits(s).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  : digits(s).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'));
const pad = (n) => String(n).padStart(2, '0');
const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDiasISO = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const diaSemana = (iso) => { const [y, m, d] = iso.split('-').map(Number); return DIAS_SEMANA[new Date(y, m - 1, d).getDay()]; };

const STATUS = {
  agendado: ['Agendado', ''], compareceu: ['Compareceu', 'warn'], em_atendimento: ['Em atendimento', 'warn'],
  realizado: ['Realizado', 'ok'], ausente: ['Ausente', 'danger'], cancelado: ['Cancelado', 'neutro'],
};
const PAGAMENTO = {
  aguardando_pagamento: ['Aguardando Pagamento', 'warn'], comprovante_enviado: ['Comprovante Enviado', ''],
  pagamento_confirmado: ['Pagamento Confirmado', 'ok'], pagamento_recusado: ['Pagamento Recusado', 'danger'],
};
const SITUACAO_VENC = { vencido: ['Vencido', 'danger'], a_vencer: ['A vencer', 'warn'], em_dia: ['Em dia', 'ok'], sem_aso: ['Sem ASO', 'danger'] };
const CONCLUSAO = { apto: ['Apto', 'ok'], apto_com_restricao: ['Apto c/ restrição', 'warn'], inapto: ['Inapto', 'danger'] };
const EVENTOS = {
  admissao: 'Admissão', periodico: 'Periódico', mudanca_funcao: 'Mudança de função', retorno_trabalho: 'Retorno ao trabalho',
  demissao: 'Demissão', aso_emitido: 'ASO emitido', exame_realizado: 'Exame realizado',
};
const tag = (mapa, k) => { const [r, c] = mapa[k] || [k, 'neutro']; return `<span class="tag ${c}">${esc(r)}</span>`; };

async function api(metodo, url, corpo, { form = false } = {}) {
  const opts = { method: metodo, headers: {} };
  if (S.token) opts.headers.Authorization = `Bearer ${S.token}`;
  if (corpo !== undefined) {
    if (form) opts.body = corpo;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(corpo); }
  }
  const r = await fetch(`/api${url}`, opts);
  if (r.status === 401 && S.token && !url.startsWith('/auth/login')) { sair(); throw new Error('Sessão expirada'); }
  const ct = r.headers.get('content-type') || '';
  const dados = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((dados && dados.erro) || `Erro ${r.status}`);
  return dados;
}

async function baixar(url, nome) {
  try {
    const r = await fetch(`/api${url}`, { headers: { Authorization: `Bearer ${S.token}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || 'Falha no download');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nome || 'arquivo';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } catch (e) { toast(e.message, 'erro'); }
}

function toast(msg, tipo = '') {
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), tipo === 'erro' ? 6000 : 3500);
}

function modal(titulo, corpo, { confirmar = 'Salvar', onConfirm, largura } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true" ${largura ? `style="max-width:${largura}px"` : ''}>
    <h2>${esc(titulo)}</h2><div class="corpo">${corpo}</div>
    <div class="rodape"><button class="btn" data-x>Fechar</button>${onConfirm ? `<button class="btn primary" data-ok>${esc(confirmar)}</button>` : ''}</div></div>`;
  const fechar = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.hasAttribute('data-x')) fechar(); });
  if (onConfirm) {
    $('[data-ok]', bg).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { if ((await onConfirm(bg)) !== false) fechar(); } catch (err) { toast(err.message, 'erro'); } finally { e.target.disabled = false; }
    });
  }
  document.body.appendChild(bg);
  const primeiro = $('input, select, textarea', bg);
  if (primeiro) primeiro.focus();
  return { el: bg, fechar };
}

const valoresForm = (el) => Object.fromEntries($$('[name]', el).map((i) => [i.name, i.type === 'checkbox' ? (i.checked ? 1 : 0) : i.value.trim()]));

function campo({ k, rot, tipo = 'text', opcoes, req, val = '', full, attrs = '' }) {
  const r = req ? ' required' : '';
  let input;
  if (tipo === 'select') {
    input = `<select name="${k}"${r} ${attrs}>${opcoes.map(([v, t]) => `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  } else if (tipo === 'textarea') input = `<textarea name="${k}"${r} ${attrs}>${esc(val)}</textarea>`;
  else input = `<input name="${k}" type="${tipo}" value="${esc(val ?? '')}"${r} ${attrs}>`;
  return `<div class="${full ? 'full' : ''}"><label>${esc(rot)}${req ? ' *' : ''}${input}</label></div>`;
}

function tabela(colunas, linhas, { onClick, vazio = 'Nenhum registro encontrado.' } = {}) {
  if (!linhas.length) return `<div class="vazio">${esc(vazio)}</div>`;
  const id = `t${Math.random().toString(36).slice(2)}`;
  setTimeout(() => {
    const t = document.getElementById(id);
    if (t && onClick) $$('tr[data-i]', t).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('button,a,input,select')) onClick(linhas[tr.dataset.i]); }));
  });
  return `<div class="tabela-wrap"><table id="${id}"><thead><tr>${colunas.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map((l, i) => `<tr data-i="${i}" class="${onClick ? 'clicavel' : ''}">${colunas.map((c) => `<td class="${c[2] || ''}">${c[1](l)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const kpi = (rot, val, alerta) => `<div class="kpi ${alerta ? 'alerta' : ''}"><div class="rot">${esc(rot)}</div><div class="val">${val}</div></div>`;
const ir = (hash) => { location.hash = hash; };

/* ================================================================== */
/* Sessão, layout e rotas                                               */
/* ================================================================== */

function sair() {
  S.token = null; S.me = null;
  try { localStorage.removeItem('uc_token'); } catch { /* */ }
  render();
}

function telaLogin() {
  $('#app').innerHTML = `<div class="login"><form class="login-card" id="flogin">
    <span class="logo-chip"><img src="/img/logo.png" alt="UrbanClin — Medicina e Segurança do Trabalho"></span>
    <p class="muted" style="text-align:center">Agenda de exames ocupacionais · NR-7 / PCMSO</p>
    <div class="grid">${campo({ k: 'login', rot: 'CNPJ ou CPF da empresa (ou e-mail)', req: true, attrs: 'autocomplete="username" autocapitalize="off"' })}
    ${campo({ k: 'senha', rot: 'Senha', tipo: 'password', req: true, attrs: 'autocomplete="current-password"' })}
    <button class="btn primary" style="justify-content:center">Entrar</button></div>
    <p class="muted small" style="text-align:center">Empresas: entre com o CNPJ ou CPF. No primeiro acesso, use a senha inicial informada pela UrbanClin e crie a sua.</p>
    <div class="demo-users">Acesso de demonstração:<br>
      ${[['Clínica', 'clinica@urbanclin.com.br', 'clinica123'], ['Médico', 'medico@urbanclin.com.br', 'medico123']]
        .map(([r, e, s]) => `<button type="button" class="btn sm" data-e="${e}" data-s="${s}">${r}</button>`).join('')}
    </div></form></div>`;
  $$('.demo-users button').forEach((b) => b.addEventListener('click', () => { $('[name=login]').value = b.dataset.e; $('[name=senha]').value = b.dataset.s; }));
  $('#flogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/auth/login', valoresForm(e.target));
      S.token = r.token;
      try { localStorage.setItem('uc_token', r.token); } catch { /* */ }
      if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
      render();
    } catch (err) { toast(err.message, 'erro'); }
  });
}

/** Primeiro acesso: troca obrigatória da senha inicial antes de usar o sistema. */
function telaPrimeiroAcesso() {
  const quem = S.me.empresa ? `${S.me.empresa.razao_social} · ${fmtCNPJ(S.me.empresa.cnpj)}` : S.me.email;
  $('#app').innerHTML = `<div class="login"><form class="login-card" id="fprim">
    <span class="logo-chip"><img src="/img/logo.png" alt="UrbanClin"></span>
    <h2 style="text-align:center;margin:4px 0">Primeiro acesso</h2>
    <p class="muted" style="text-align:center">${esc(quem)}<br>Crie a sua senha para continuar.</p>
    <div class="grid">${campo({ k: 'atual', rot: 'Senha inicial', tipo: 'password', req: true, attrs: 'autocomplete="current-password"' })}
    ${campo({ k: 'nova', rot: 'Nova senha (mín. 6)', tipo: 'password', req: true, attrs: 'autocomplete="new-password"' })}
    ${campo({ k: 'confirma', rot: 'Repita a nova senha', tipo: 'password', req: true, attrs: 'autocomplete="new-password"' })}
    <button class="btn primary" style="justify-content:center">Salvar e entrar</button>
    <button type="button" class="btn" id="psair" style="justify-content:center">Sair</button></div></form></div>`;
  $('#psair').addEventListener('click', sair);
  $('#fprim').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = valoresForm(e.target);
    if (v.nova !== v.confirma) return toast('As senhas não conferem', 'erro');
    try {
      await api('POST', '/auth/senha', { atual: v.atual, nova: v.nova });
      toast('Senha criada', 'ok');
      S.me = null;
      if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
      render();
    } catch (err) { toast(err.message, 'erro'); }
  });
}

const MENUS = {
  admin: [
    ['Visão geral', [['dashboard', 'Dashboard'], ['agendamentos', 'Agendamentos'], ['novo', 'Novo agendamento']]],
    ['PCMSO', [['funcionarios', 'Funcionários'], ['vencimentos', 'Vencimentos'], ['asos', 'ASOs']]],
    ['Cadastros', [['empresas', 'Empresas'], ['clinicas', 'Clínicas'], ['medicos', 'Médicos'], ['usuarios', 'Usuários'], ['tipos', 'Tipos de exame']]],
    ['Financeiro', [['precos', 'Valores'], ['pix', 'Configurar PIX'], ['faturamento', 'Faturamento']]],
    ['Sistema', [['relatorios', 'Relatórios'], ['notificacoes', 'Envios e alertas']]],
  ],
  clinica: [['Clínica', [['dashboard', 'Dashboard'], ['agenda', 'Agenda diária'], ['agendamentos', 'Todos os agendamentos'], ['asos', 'ASOs emitidos']]]],
  medico: [['Médico', [['dashboard', 'Dashboard'], ['agenda', 'Minha agenda'], ['asos', 'ASOs / assinaturas']]]],
  empresa: [
    ['Empresa', [['dashboard', 'Dashboard'], ['novo', 'Solicitar exame'], ['agendamentos', 'Histórico de exames']]],
    ['PCMSO', [['funcionarios', 'Funcionários'], ['vencimentos', 'Vencimentos'], ['asos', 'ASOs e documentos']]],
  ],
};
const PERFIL_NOME = { admin: 'Administrador', clinica: 'Clínica', medico: 'Médico', empresa: 'Empresa' };

function layout() {
  const menus = MENUS[S.me.perfil] || [];
  const vinculo = S.me.empresa ? S.me.empresa.razao_social : S.me.clinica ? S.me.clinica.nome : S.me.medico ? `CRM ${S.me.medico.crm}/${S.me.medico.uf_crm}` : '';
  $('#app').innerHTML = `<div class="topbar"><button id="abrirMenu" aria-label="Abrir menu">☰</button><img src="/img/logo.png" alt="UrbanClin"></div>
  <div class="layout"><aside class="sidebar" id="sidebar">
    <a href="#/dashboard" class="logo-chip"><img src="/img/logo.png" alt="UrbanClin — Medicina e Segurança do Trabalho"></a>
    <nav>${menus.map(([g, itens]) => `<div class="grupo">${esc(g)}</div>${itens.map(([r, t]) => `<a href="#/${r}" data-r="${r}">${esc(t)}</a>`).join('')}`).join('')}</nav>
    <div class="userbox"><strong>${esc(S.me.nome)}</strong><br><span style="opacity:.75">${esc(PERFIL_NOME[S.me.perfil])}${vinculo ? ` · ${esc(vinculo)}` : ''}</span><br>
      <a href="#/senha">Alterar senha</a> · <a href="#" id="sair">Sair</a></div>
  </aside><main id="main"></main></div>`;
  $('#sair').addEventListener('click', (e) => { e.preventDefault(); sair(); });
  $('#abrirMenu').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#sidebar').addEventListener('click', (e) => { if (e.target.tagName === 'A') $('#sidebar').classList.remove('open'); });
}

const ROTAS = {};
async function render() {
  const [rota, ...args] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  const [nome, qs] = rota.split('?');
  if (nome === 'verificar') return pgVerificar(args[0]);
  if (!S.token) return telaLogin();
  if (!S.me) {
    try { S.me = await api('GET', '/auth/me'); } catch { return telaLogin(); }
    if (S.me.trocar_senha) return telaPrimeiroAcesso();
    layout();
  }
  if (!$('#main')) layout();
  S.charts.forEach((c) => c.destroy());
  S.charts = [];
  $$('#sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === nome));
  const main = $('#main');
  main.innerHTML = '<div class="muted">Carregando…</div>';
  const fn = ROTAS[nome] || ROTAS.dashboard;
  try { await fn(main, args, new URLSearchParams(qs || '')); } catch (e) { main.innerHTML = `<div class="card aviso">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
document.addEventListener('DOMContentLoaded', render);

/* ================================================================== */
/* Dashboards                                                           */
/* ================================================================== */

function grafico(canvas, config) {
  if (!window.Chart) { canvas.parentElement.innerHTML = '<div class="vazio">Gráfico indisponível (sem conexão com a biblioteca).</div>'; return; }
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue('--muted').trim();
  Chart.defaults.borderColor = css.getPropertyValue('--border').trim();
  S.charts.push(new Chart(canvas, { ...config, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } }, ...(config.options || {}) } }));
}
const corPrimaria = () => getComputedStyle(document.documentElement).getPropertyValue('--primary-2').trim();
const mesRot = (m) => { const [y, mm] = m.split('-'); return `${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'][Number(mm) - 1]}/${y.slice(2)}`; };

const colAgenda = [
  ['Hora', (a) => `<strong>${esc(a.hora)}</strong>`],
  ['Funcionário', (a) => `${esc(a.func_nome)}<div class="small muted">${esc(a.razao_social)}</div>`],
  ['Exame', (a) => esc(a.tipo_nome)],
  ['Status', (a) => tag(STATUS, a.status)],
  ['Pagamento', (a) => tag(PAGAMENTO, a.status_pagamento)],
];
const colLista = [
  ['Data', (a) => `${fmtData(a.data)} <span class="muted small">${esc(a.hora)}</span>`],
  ['Funcionário', (a) => `${esc(a.func_nome)}<div class="small muted">${esc(fmtCPF(a.func_cpf))}</div>`],
  ['Empresa', (a) => esc(a.razao_social)],
  ['Exame', (a) => esc(a.tipo_nome)],
  ['Clínica', (a) => esc(a.clinica_nome)],
  ['Valor', (a) => fmtMoeda(a.valor), 'num'],
  ['Status', (a) => tag(STATUS, a.status)],
  ['Pagamento', (a) => tag(PAGAMENTO, a.status_pagamento)],
];
const abrirAg = (a) => ir(`#/agendamento/${a.id}`);

ROTAS.dashboard = async (main) => {
  const d = await api('GET', '/dashboard');
  const p = S.me.perfil;
  if (p === 'admin') {
    const i = d.indicadores;
    main.innerHTML = `<h1>Dashboard administrativo</h1>
      <div class="kpis">${kpi('Exames agendados hoje', i.agendados_hoje)}${kpi('Exames realizados hoje', i.realizados_hoje)}${kpi('Exames pendentes', i.pendentes)}
      ${kpi('Cancelamentos no mês', i.cancelamentos_mes)}${kpi('Receita do dia', fmtMoeda(i.receita_dia))}${kpi('Receita mensal', fmtMoeda(i.receita_mes))}
      ${kpi('Receita anual', fmtMoeda(i.receita_ano))}${kpi('Comprovantes a conferir', i.pagamentos_a_conferir, i.pagamentos_a_conferir > 0)}</div>
      <div class="cols-2">
        <div class="card"><h3>Agendamentos por período (30 dias)</h3><div class="chart-box"><canvas id="g1"></canvas></div></div>
        <div class="card"><h3>Faturamento (12 meses)</h3><div class="chart-box"><canvas id="g2"></canvas></div></div>
        <div class="card"><h3>Exames por empresa (12 meses)</h3><div class="chart-box"><canvas id="g3"></canvas></div></div>
        <div class="card"><h3>Comparecimento (12 meses)</h3><div class="chart-box"><canvas id="g4"></canvas></div></div>
      </div>`;
    const g = d.graficos;
    const cor = corPrimaria();
    grafico($('#g1'), { type: 'bar', data: { labels: g.agendamentos_por_dia.map((x) => fmtData(x.rotulo).slice(0, 5)), datasets: [{ label: 'Agendamentos', data: g.agendamentos_por_dia.map((x) => x.valor), backgroundColor: cor, borderRadius: 4 }] }, options: { plugins: { legend: { display: false } } } });
    grafico($('#g2'), { type: 'line', data: { labels: g.faturamento_mensal.map((x) => mesRot(x.rotulo)), datasets: [{ label: 'Receita confirmada (R$)', data: g.faturamento_mensal.map((x) => x.valor), borderColor: '#f39200', backgroundColor: '#f3920033', fill: true, tension: 0.3 }] } });
    grafico($('#g3'), { type: 'bar', data: { labels: g.exames_por_empresa.map((x) => x.rotulo), datasets: [{ label: 'Exames', data: g.exames_por_empresa.map((x) => x.valor), backgroundColor: cor, borderRadius: 4 }] }, options: { indexAxis: 'y', plugins: { legend: { display: false } } } });
    grafico($('#g4'), { type: 'bar', data: { labels: g.comparecimento_mensal.map((x) => mesRot(x.rotulo)), datasets: [
      { label: 'Realizados', data: g.comparecimento_mensal.map((x) => x.realizados), backgroundColor: '#2e7d32' },
      { label: 'Ausentes', data: g.comparecimento_mensal.map((x) => x.ausentes), backgroundColor: '#c62828' },
      { label: 'Cancelados', data: g.comparecimento_mensal.map((x) => x.cancelados), backgroundColor: '#90a4ae' },
    ] }, options: { scales: { x: { stacked: true }, y: { stacked: true } } } });
    return;
  }
  if (p === 'empresa') {
    main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>Painel da empresa</h1><a class="btn primary" href="#/novo">+ Solicitar exame</a></div>
      <div class="kpis">${kpi('Exames solicitados', d.exames_solicitados)}${kpi('Exames pendentes', d.exames_pendentes)}${kpi('ASOs disponíveis', d.asos_disponiveis)}
      ${kpi('Vencimentos próximos (90 dias)', d.vencimentos_proximos.length, d.vencimentos_proximos.length > 0)}${kpi('Funcionários em atraso', d.funcionarios_em_atraso.length, d.funcionarios_em_atraso.length > 0)}
      ${kpi('Pagamentos pendentes', d.pagamentos_pendentes, d.pagamentos_pendentes > 0)}</div>
      <div class="card"><h3>Próximos exames</h3>${tabela(colLista.filter((c) => c[0] !== 'Empresa'), d.proximos_exames, { onClick: abrirAg, vazio: 'Nenhum exame agendado.' })}</div>
      <div class="cols-2"><div class="card"><h3>Vencimentos próximos</h3>${tabelaVenc(d.vencimentos_proximos)}</div>
      <div class="card"><h3>Funcionários em atraso</h3>${tabelaVenc(d.funcionarios_em_atraso)}</div></div>`;
    return;
  }
  const extra = p === 'medico' ? kpi('ASOs aguardando assinatura', d.asos_pendentes_assinatura, d.asos_pendentes_assinatura > 0) : '';
  main.innerHTML = `<h1>${p === 'medico' ? 'Painel do médico' : 'Painel da clínica'}</h1>
    <div class="kpis">${kpi('Atendimentos do dia', d.atendimentos_do_dia.length)}${kpi('Próximos atendimentos (7 dias)', d.proximos_atendimentos.length)}
    ${kpi('Pagamentos pendentes', d.pagamentos_pendentes.length, d.pagamentos_pendentes.length > 0)}${kpi('Exames concluídos hoje', d.exames_concluidos_hoje)}
    ${kpi('Concluídos no mês', d.exames_concluidos_mes)}${kpi('Pacientes ausentes (30 dias)', d.pacientes_ausentes.length)}${extra}</div>
    <div class="card"><h3>Atendimentos do dia — ${fmtData(hojeISO())}</h3>${tabela(colAgenda, d.atendimentos_do_dia, { onClick: abrirAg, vazio: 'Nenhum atendimento hoje.' })}</div>
    <div class="cols-2">
      <div class="card"><h3>Pagamentos pendentes</h3>${tabela([['Data', (a) => fmtData(a.data)], ['Funcionário', (a) => esc(a.func_nome)], ['Valor', (a) => fmtMoeda(a.valor), 'num'], ['Situação', (a) => tag(PAGAMENTO, a.status_pagamento)]], d.pagamentos_pendentes, { onClick: abrirAg, vazio: 'Nenhum pagamento pendente.' })}</div>
      <div class="card"><h3>Próximos atendimentos</h3>${tabela([['Data', (a) => `${fmtData(a.data)} ${esc(a.hora)}`], ['Funcionário', (a) => esc(a.func_nome)], ['Exame', (a) => esc(a.tipo_nome)]], d.proximos_atendimentos, { onClick: abrirAg, vazio: 'Nenhum atendimento nos próximos dias.' })}</div>
      <div class="card"><h3>Pacientes ausentes</h3>${tabela([['Data', (a) => `${fmtData(a.data)} ${esc(a.hora)}`], ['Funcionário', (a) => esc(a.func_nome)], ['Empresa', (a) => esc(a.razao_social)]], d.pacientes_ausentes, { onClick: abrirAg, vazio: 'Nenhuma ausência recente.' })}</div>
    </div>`;
};

function tabelaVenc(linhas) {
  return tabela([
    ['Funcionário', (v) => `${esc(v.nome)}<div class="small muted">${esc(v.funcao)}</div>`],
    ['Validade', (v) => (v.data_validade ? `${fmtData(v.data_validade)}<div class="small muted">${v.dias_para_vencer < 0 ? `${-v.dias_para_vencer} dias atrás` : `em ${v.dias_para_vencer} dias`}</div>` : '—')],
    ['Situação', (v) => tag(SITUACAO_VENC, v.situacao) + (v.proximo_agendamento ? '<div class="small muted">já agendado</div>' : '')],
  ], linhas, { onClick: (v) => ir(`#/funcionario/${v.funcionario_id}`), vazio: 'Nenhum funcionário nesta situação.' });
}

/* ================================================================== */
/* Agendamentos e agenda diária                                         */
/* ================================================================== */

ROTAS.agendamentos = async (main, _a, qs) => {
  const f = { de: qs.get('de') || '', ate: qs.get('ate') || '', status: qs.get('status') || '', pagamento: qs.get('pagamento') || '', q: qs.get('q') || '' };
  main.innerHTML = `<h1>${S.me.perfil === 'empresa' ? 'Histórico de exames' : 'Agendamentos'}</h1>
    <div class="card"><form class="filtros" id="ff">
      ${campo({ k: 'q', rot: 'Buscar (nome, CPF, código)', val: f.q })}${campo({ k: 'de', rot: 'De', tipo: 'date', val: f.de })}${campo({ k: 'ate', rot: 'Até', tipo: 'date', val: f.ate })}
      ${campo({ k: 'status', rot: 'Status', tipo: 'select', val: f.status, opcoes: [['', 'Todos'], ...Object.entries(STATUS).map(([k, v]) => [k, v[0]])] })}
      ${campo({ k: 'pagamento', rot: 'Pagamento', tipo: 'select', val: f.pagamento, opcoes: [['', 'Todos'], ...Object.entries(PAGAMENTO).map(([k, v]) => [k, v[0]])] })}
      <button class="btn primary">Filtrar</button></form><div id="lista"></div></div>`;
  $('#ff').addEventListener('submit', (e) => { e.preventDefault(); ir(`#/agendamentos?${new URLSearchParams(Object.entries(valoresForm(e.target)).filter(([, v]) => v))}`); });
  const lista = await api('GET', `/agendamentos?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`);
  $('#lista').innerHTML = tabela(S.me.perfil === 'empresa' ? colLista.filter((c) => c[0] !== 'Empresa') : colLista, lista, { onClick: abrirAg });
};

ROTAS.agenda = async (main, _a, qs) => {
  const data = qs.get('data') || hojeISO();
  main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>Agenda — ${diaSemana(data)}, ${fmtData(data)}</h1>
    <div class="acoes"><a class="btn" href="#/agenda?data=${addDiasISO(data, -1)}">‹ Anterior</a><a class="btn" href="#/agenda?data=${hojeISO()}">Hoje</a>
    <a class="btn" href="#/agenda?data=${addDiasISO(data, 1)}">Próximo ›</a><input type="date" id="dt" value="${data}" style="width:auto;margin:0"></div></div>
    <div class="card" id="lista"></div>`;
  $('#dt').addEventListener('change', (e) => ir(`#/agenda?data=${e.target.value}`));
  const lista = (await api('GET', `/agendamentos?data=${data}&ordem=asc`)).filter((a) => a.status !== 'cancelado');
  const podeAtender = data <= hojeISO();
  $('#lista').innerHTML = tabela([...colAgenda, ['Ações', (a) => acoesRapidas(a, podeAtender)]], lista, { onClick: abrirAg, vazio: 'Nenhum atendimento nesta data.' });
  $$('#lista [data-acao]').forEach((b) => b.addEventListener('click', async () => {
    try {
      const { acao, id } = b.dataset;
      if (acao === 'pagar') await api('POST', `/agendamentos/${id}/pagamento`, { acao: 'confirmar' });
      else await api('POST', `/agendamentos/${id}/status`, { status: acao });
      toast('Atualizado', 'ok');
      render();
    } catch (e) { toast(e.message, 'erro'); }
  }));
};

function acoesRapidas(a, podeAtender) {
  const b = [];
  if (S.me.perfil === 'clinica' && a.status_pagamento !== 'pagamento_confirmado' && ['agendado', 'compareceu'].includes(a.status)) b.push(`<button class="btn sm ok" data-acao="pagar" data-id="${a.id}">Confirmar pagamento</button>`);
  if (podeAtender && a.status === 'agendado' && a.status_pagamento === 'pagamento_confirmado') b.push(`<button class="btn sm" data-acao="compareceu" data-id="${a.id}">Compareceu</button>`);
  if (podeAtender && a.status === 'agendado' && S.me.perfil === 'clinica') b.push(`<button class="btn sm danger" data-acao="ausente" data-id="${a.id}">Ausente</button>`);
  if (S.me.perfil === 'medico' && a.status === 'compareceu') b.push(`<button class="btn sm primary" data-acao="em_atendimento" data-id="${a.id}">Atender</button>`);
  return `<div class="acoes">${b.join('')}</div>`;
}

/* ================================================================== */
/* Detalhe do agendamento                                               */
/* ================================================================== */

ROTAS.agendamento = async (main, [id]) => {
  const a = await api('GET', `/agendamentos/${id}`);
  const p = S.me.perfil;
  const aberto = !['realizado', 'cancelado'].includes(a.status);
  const pago = a.status_pagamento === 'pagamento_confirmado';
  const noDia = a.data <= hojeISO();
  const btn = (acao, txt, cls = '') => `<button class="btn ${cls}" data-acao="${acao}">${txt}</button>`;
  const acoes = [btn('guia', 'Baixar guia (PDF)')];
  if (['empresa', 'admin', 'clinica'].includes(p) && aberto) acoes.push(btn('reenviar', 'Reenviar guia'));
  if (['empresa', 'admin', 'clinica'].includes(p) && aberto && !pago) acoes.push(btn('comprovante', 'Enviar comprovante', 'primary'));
  if (['clinica', 'admin'].includes(p) && aberto && !pago) acoes.push(btn('confirmar', 'Confirmar pagamento', 'ok'), btn('recusar', 'Recusar pagamento', 'danger'));
  if (['clinica', 'admin'].includes(p) && noDia && a.status === 'agendado' && pago) acoes.push(btn('compareceu', 'Confirmar comparecimento', 'primary'));
  if (['clinica', 'admin'].includes(p) && noDia && a.status === 'agendado') acoes.push(btn('ausente', 'Marcar ausente', 'danger'));
  if (p === 'medico' && a.status === 'compareceu') acoes.push(btn('em_atendimento', 'Iniciar atendimento', 'primary'));
  if (['clinica', 'medico'].includes(p) && ['compareceu', 'em_atendimento'].includes(a.status)) acoes.push(btn('resultado', 'Inserir resultado'), btn('laudo', 'Anexar laudo'));
  if (p === 'medico' && aberto) acoes.push(btn('obs', 'Registrar observações'));
  if (['clinica', 'medico'].includes(p) && ['compareceu', 'em_atendimento'].includes(a.status) && !a.aso) acoes.push(btn('aso', 'Emitir ASO', 'ok'));
  if (['empresa', 'clinica', 'admin'].includes(p) && ['agendado', 'ausente'].includes(a.status)) acoes.push(btn('reagendar', 'Reagendar'));
  if (['empresa', 'clinica', 'admin'].includes(p) && aberto) acoes.push(btn('cancelar', 'Cancelar', 'danger'));

  main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>Agendamento ${esc(a.codigo)}</h1>
      <div class="acoes">${tag(STATUS, a.status)} ${tag(PAGAMENTO, a.status_pagamento)}</div></div>
    ${!pago && aberto ? `<div class="aviso" style="margin-bottom:16px">IMPORTANTE: o comprovante de pagamento deverá ser enviado à clínica antes da realização do exame. O funcionário somente será atendido após a confirmação do pagamento.
      ${a.status_pagamento === 'pagamento_recusado' ? `<br>Motivo da recusa: ${esc(a.motivo_recusa)}` : ''}</div>` : ''}
    <div class="card"><div class="acoes" id="acoes">${acoes.join('')}</div></div>
    <div class="cols-2">
      <div class="card"><h3>Exame</h3><dl class="dl">
        <dt>Tipo (NR-7)</dt><dd>${esc(a.tipo_nome)}</dd>
        ${a.funcao_nova ? `<dt>Mudança de função</dt><dd>${esc(a.funcao_atual)} → <strong>${esc(a.funcao_nova)}</strong></dd>` : ''}
        <dt>Data e horário</dt><dd>${diaSemana(a.data)}, ${fmtData(a.data)} às ${esc(a.hora)}</dd>
        <dt>Valor</dt><dd><strong>${fmtMoeda(a.valor)}</strong></dd>
        <dt>Médico</dt><dd>${esc(a.medico_nome || '—')}</dd>
        ${a.observacoes_empresa ? `<dt>Observações</dt><dd>${esc(a.observacoes_empresa)}</dd>` : ''}
        ${a.observacoes_medico ? `<dt>Observações médicas</dt><dd>${esc(a.observacoes_medico)}</dd>` : ''}
      </dl></div>
      <div class="card"><h3>Funcionário</h3><dl class="dl">
        <dt>Nome</dt><dd>${p !== 'medico' && p !== 'clinica' ? `<a href="#/funcionario/${a.funcionario_id}">${esc(a.func_nome)}</a>` : esc(a.func_nome)}</dd>
        <dt>CPF</dt><dd>${esc(fmtCPF(a.func_cpf))}</dd><dt>RG</dt><dd>${esc(a.func_rg)}</dd>
        <dt>Nascimento</dt><dd>${fmtData(a.func_nascimento)}</dd><dt>Função</dt><dd>${esc(a.func_funcao)}</dd><dt>Telefone</dt><dd>${esc(a.func_telefone)}</dd>
      </dl></div>
      <div class="card"><h3>Empresa</h3><dl class="dl">
        <dt>Razão social</dt><dd>${esc(a.razao_social)}</dd><dt>CNPJ</dt><dd>${esc(fmtCNPJ(a.cnpj))}</dd>
        <dt>Responsável</dt><dd>${esc(a.responsavel)}</dd><dt>Contato</dt><dd>${esc(a.empresa_telefone)} · ${esc(a.empresa_email)}</dd>
      </dl></div>
      <div class="card"><h3>Clínica</h3><dl class="dl">
        <dt>Nome</dt><dd>${esc(a.clinica_nome)}</dd>
        <dt>Endereço</dt><dd>${esc(a.clinica_endereco)}${a.clinica_bairro ? ` — ${esc(a.clinica_bairro)}` : ''}<br>${esc(a.clinica_cidade)}/${esc(a.clinica_uf)} ${a.clinica_cep ? `· CEP ${esc(a.clinica_cep)}` : ''}</dd>
        <dt>Telefone</dt><dd>${esc(a.clinica_telefone)}</dd>
        <dt>Mapa</dt><dd><a target="_blank" rel="noopener" href="${esc(a.maps_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.clinica_endereco}, ${a.clinica_cidade}, ${a.clinica_uf}`)}`)}">Abrir no Google Maps</a></dd>
      </dl></div>
    </div>
    ${a.pix_payload && !pago ? `<div class="card"><h3>Pagamento via PIX</h3><p>Valor: <strong>${fmtMoeda(a.valor)}</strong>. O QR Code está na guia em PDF. PIX copia e cola:</p>
      <div class="pix-code" id="pix">${esc(a.pix_payload)}</div><p><button class="btn sm" id="copiarPix">Copiar código PIX</button></p></div>` : ''}
    <div class="cols-2">
      <div class="card"><h3>Resultados</h3>${tabela([['Exame', (r) => esc(r.exame)], ['Resultado', (r) => esc(r.resultado || '—')], ['Observação', (r) => esc(r.observacao || '')]], a.resultados, { vazio: 'Nenhum resultado registrado.' })}</div>
      <div class="card"><h3>Documentos</h3>${tabela([['Tipo', (d) => `<span class="tag">${esc(d.tipo)}</span>`], ['Arquivo', (d) => esc(d.nome)], ['', (d) => `<button class="btn sm" data-doc="${d.id}" data-nome="${esc(d.nome)}">Baixar</button>`]], a.documentos, { vazio: 'Nenhum documento.' })}</div>
    </div>
    ${a.aso ? cartaoASO(a.aso) : ''}
    <div class="card"><h3>Envios (e-mail / WhatsApp)</h3>${tabela([['Quando', (n) => esc(n.created_at)], ['Canal', (n) => esc(n.canal)], ['Destino', (n) => esc(n.destino)], ['Assunto', (n) => esc(n.assunto || '')], ['Status', (n) => `<span class="tag ${n.status === 'enviado' ? 'ok' : n.status === 'erro' ? 'danger' : 'neutro'}">${esc(n.status)}</span>`]], a.notificacoes, { vazio: 'Nenhum envio registrado.' })}</div>`;

  $$('[data-doc]').forEach((b) => b.addEventListener('click', () => baixar(`/documentos/${b.dataset.doc}`, b.dataset.nome)));
  const cp = $('#copiarPix');
  if (cp) cp.addEventListener('click', () => navigator.clipboard.writeText(a.pix_payload).then(() => toast('Código PIX copiado', 'ok')));
  ligarASO(a.aso);

  const recarregar = () => render();
  const post = async (url, corpo, msg) => { await api('POST', url, corpo); toast(msg, 'ok'); recarregar(); };
  const handlers = {
    guia: () => baixar(`/agendamentos/${a.id}/guia`, `Guia ${a.codigo}.pdf`),
    reenviar: () => post(`/agendamentos/${a.id}/reenviar`, {}, 'Guia reenviada para empresa, funcionário e clínica'),
    confirmar: () => post(`/agendamentos/${a.id}/pagamento`, { acao: 'confirmar' }, 'Pagamento confirmado'),
    compareceu: () => post(`/agendamentos/${a.id}/status`, { status: 'compareceu' }, 'Comparecimento confirmado'),
    ausente: () => post(`/agendamentos/${a.id}/status`, { status: 'ausente' }, 'Marcado como ausente'),
    em_atendimento: () => post(`/agendamentos/${a.id}/status`, { status: 'em_atendimento' }, 'Atendimento iniciado'),
    recusar: () => modal('Recusar pagamento', `<div class="form">${campo({ k: 'motivo', rot: 'Motivo', tipo: 'textarea', req: true, full: true })}</div>`, {
      confirmar: 'Recusar', onConfirm: async (m) => post(`/agendamentos/${a.id}/pagamento`, { acao: 'recusar', motivo: valoresForm(m).motivo }, 'Pagamento recusado'),
    }),
    comprovante: () => uploadModal('Enviar comprovante de pagamento', `/agendamentos/${a.id}/comprovante`, 'Comprovante enviado', recarregar),
    laudo: () => uploadModal('Anexar laudo', `/agendamentos/${a.id}/laudo`, 'Laudo anexado', recarregar, true),
    resultado: () => modal('Inserir resultado', `<div class="form">${campo({ k: 'exame', rot: 'Exame', req: true, attrs: 'list="examesCompl"' })}${campo({ k: 'resultado', rot: 'Resultado' })}
      ${campo({ k: 'observacao', rot: 'Observação', tipo: 'textarea', full: true })}</div><datalist id="examesCompl"></datalist>`, {
      onConfirm: async (m) => post(`/agendamentos/${a.id}/resultados`, valoresForm(m), 'Resultado registrado'),
    }) && api('GET', '/tipos-exame').then((t) => { const dl = $('#examesCompl'); if (dl) dl.innerHTML = t.filter((x) => x.categoria === 'complementar').map((x) => `<option value="${esc(x.nome)}">`).join(''); }),
    obs: () => modal('Observações médicas', `<div class="form">${campo({ k: 'observacoes', rot: 'Observações', tipo: 'textarea', full: true, val: a.observacoes_medico || '' })}</div>`, {
      onConfirm: async (m) => post(`/agendamentos/${a.id}/observacoes`, valoresForm(m), 'Observações registradas'),
    }),
    aso: () => modalASO(a),
    reagendar: () => modalReagendar(a),
    cancelar: () => modal('Cancelar agendamento', `<p>Confirma o cancelamento do exame de <strong>${esc(a.func_nome)}</strong> em ${fmtData(a.data)}?</p><div class="form">${campo({ k: 'motivo', rot: 'Motivo (opcional)', full: true })}</div>`, {
      confirmar: 'Cancelar exame', onConfirm: async (m) => post(`/agendamentos/${a.id}/cancelar`, valoresForm(m), 'Agendamento cancelado'),
    }),
  };
  $$('#acoes [data-acao]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await handlers[b.dataset.acao](); } catch (e) { toast(e.message, 'erro'); } finally { b.disabled = false; }
  }));
};

function cartaoASO(s) {
  return `<div class="card"><div class="acoes" style="justify-content:space-between"><h3>ASO nº ${String(s.id).padStart(6, '0')}</h3>
    <div class="acoes"><button class="btn sm" data-aso-pdf="${s.id}">Baixar ASO (PDF)</button>
    ${S.me.perfil === 'medico' && !s.hash_assinatura ? `<button class="btn sm ok" data-assinar="${s.id}">Assinar eletronicamente</button>` : ''}</div></div>
    <dl class="dl"><dt>Conclusão</dt><dd>${tag(CONCLUSAO, s.conclusao)}${s.restricoes ? ` — ${esc(s.restricoes)}` : ''}</dd>
    <dt>Emissão</dt><dd>${fmtData(s.data_emissao)}</dd><dt>Validade</dt><dd>${s.data_validade ? fmtData(s.data_validade) : 'Não se aplica'}</dd>
    <dt>Médico</dt><dd>${esc(s.medico_nome || '—')} ${s.medico_crm ? `(CRM ${esc(s.medico_crm)}/${esc(s.medico_uf_crm)})` : ''}</dd>
    <dt>Assinatura</dt><dd>${s.hash_assinatura ? `<span class="tag ok">Assinado em ${esc(s.assinado_em)}</span><div class="small muted" style="word-break:break-all">${esc(s.hash_assinatura)}</div>` : '<span class="tag warn">Aguardando assinatura do médico</span>'}</dd></dl></div>`;
}

function ligarASO() {
  $$('[data-aso-pdf]').forEach((b) => b.addEventListener('click', () => baixar(`/asos/${b.dataset.asoPdf}/pdf`, `ASO ${b.dataset.asoPdf}.pdf`)));
  $$('[data-assinar]').forEach((b) => b.addEventListener('click', () => modal('Assinar ASO eletronicamente',
    '<p>Ao confirmar, o ASO será assinado eletronicamente em seu nome e CRM, com registro de data/hora e código de verificação (hash SHA-256). Esta ação não pode ser desfeita.</p>', {
      confirmar: 'Assinar', onConfirm: async () => { await api('POST', `/asos/${b.dataset.assinar}/assinar`); toast('ASO assinado', 'ok'); render(); },
    })));
}

function uploadModal(titulo, url, msg, depois, comNome) {
  modal(titulo, `<div class="form">${comNome ? campo({ k: 'nome', rot: 'Descrição', full: true }) : ''}
    <div class="full"><label>Arquivo (PDF, JPG, PNG — até 10 MB) *<input type="file" id="arq" accept=".pdf,image/*" required></label></div></div>`, {
    confirmar: 'Enviar',
    onConfirm: async (m) => {
      const f = $('#arq', m).files[0];
      if (!f) throw new Error('Selecione um arquivo');
      const fd = new FormData();
      fd.append('arquivo', f);
      if (comNome) fd.append('nome', valoresForm(m).nome || f.name);
      await api('POST', url, fd, { form: true });
      toast(msg, 'ok');
      depois();
    },
  });
}

async function modalASO(a) {
  const medicos = S.me.perfil === 'clinica' ? await api('GET', '/medicos') : [];
  const exames = a.resultados.map((r) => `${r.exame}${r.resultado ? `: ${r.resultado}` : ''}`).join('; ');
  modal(`Emitir ASO — ${a.tipo_nome}`, `<div class="form">
    ${S.me.perfil === 'clinica' ? campo({ k: 'medico_id', rot: 'Médico responsável', tipo: 'select', req: true, val: a.medico_id, opcoes: [['', 'Selecione…'], ...medicos.map((m) => [m.id, `${m.nome} — CRM ${m.crm}/${m.uf_crm}`])] }) : ''}
    ${campo({ k: 'conclusao', rot: 'Conclusão', tipo: 'select', req: true, opcoes: [['apto', 'Apto'], ['apto_com_restricao', 'Apto com restrição'], ['inapto', 'Inapto']] })}
    ${campo({ k: 'riscos', rot: a.riscos ? 'Riscos ocupacionais (cadastro da função)' : 'Riscos ocupacionais (função sem cadastro — sairá em branco)', tipo: 'textarea', full: true, val: a.riscos || '' })}
    ${campo({ k: 'exames_realizados', rot: 'Exames realizados', tipo: 'textarea', full: true, val: exames || 'Exame clínico ocupacional' })}
    ${campo({ k: 'restricoes', rot: 'Restrições (se houver)', full: true })}
    ${campo({ k: 'observacoes', rot: 'Observações', tipo: 'textarea', full: true })}
    </div>${S.me.perfil === 'medico' ? '<p class="info small">O ASO será assinado eletronicamente em seu nome ao emitir.</p>' : '<p class="muted small">Após a emissão, o médico poderá assinar o ASO eletronicamente.</p>'}`, {
    confirmar: 'Emitir ASO', largura: 720,
    onConfirm: async (m) => { await api('POST', `/agendamentos/${a.id}/aso`, valoresForm(m)); toast('ASO emitido e enviado para a empresa', 'ok'); render(); },
  });
}

async function modalReagendar(a) {
  const m = modal('Reagendar exame', `<p class="muted">Clínica: ${esc(a.clinica_nome)}</p><div id="seletor"></div>`, {
    confirmar: 'Reagendar',
    onConfirm: async () => {
      if (!sel.data || !sel.hora) throw new Error('Escolha data e horário');
      await api('POST', `/agendamentos/${a.id}/reagendar`, { data: sel.data, hora: sel.hora });
      toast('Exame reagendado; nova guia enviada', 'ok');
      render();
    },
  });
  const sel = {};
  await seletorDataHora($('#seletor', m.el), a.clinica_id, sel);
}

/** Lista datas disponíveis e horários livres da clínica. */
async function seletorDataHora(el, clinicaId, sel, aoMudar = () => {}) {
  el.innerHTML = '<div class="muted">Carregando datas…</div>';
  const datas = await api('GET', `/clinicas/${clinicaId}/datas?dias=45`);
  if (!datas.length) { el.innerHTML = '<div class="vazio">Sem datas disponíveis nos próximos dias.</div>'; return; }
  el.innerHTML = `<h3>Datas disponíveis</h3><div class="slots" id="sdatas">${datas.map((d) => `<button type="button" class="slot" data-d="${d.data}">${diaSemana(d.data)} ${fmtData(d.data).slice(0, 5)}<div class="small" style="opacity:.7">${d.vagas} vagas</div></button>`).join('')}</div>
    <h3 style="margin-top:16px">Horários disponíveis</h3><div class="slots" id="shoras"><span class="muted">Escolha uma data.</span></div>`;
  $$('#sdatas .slot', el).forEach((b) => b.addEventListener('click', async () => {
    $$('#sdatas .slot', el).forEach((x) => x.classList.toggle('sel', x === b));
    sel.data = b.dataset.d; sel.hora = null; aoMudar();
    const horas = await api('GET', `/clinicas/${clinicaId}/horarios?data=${sel.data}`);
    $('#shoras', el).innerHTML = horas.map((h) => `<button type="button" class="slot" data-h="${h}">${h}</button>`).join('') || '<span class="muted">Sem horários.</span>';
    $$('#shoras .slot', el).forEach((hb) => hb.addEventListener('click', () => {
      $$('#shoras .slot', el).forEach((x) => x.classList.toggle('sel', x === hb));
      sel.hora = hb.dataset.h; aoMudar();
    }));
  }));
}

/* ================================================================== */
/* Solicitação / agendamento de exame (wizard)                          */
/* ================================================================== */

ROTAS.novo = async (main, _a, qs) => {
  const tipos = (await api('GET', '/tipos-exame')).filter((t) => t.categoria === 'ocupacional');
  const W = { passo: 1, empresa: {}, funcionario: {}, tipo: '', funcao_nova: '', clinica: null, data: null, hora: null, observacoes: '' };
  if (S.me.empresa) W.empresa = { ...S.me.empresa };
  const fid = qs.get('funcionario');
  if (fid) {
    const f = await api('GET', `/funcionarios/${fid}`);
    W.funcionario = { nome: f.nome, rg: f.rg, cpf: f.cpf, telefone: f.telefone, email: f.email || '', data_nascimento: f.data_nascimento, funcao: f.funcao };
    if (S.me.perfil === 'admin') W.empresa = { cnpj: f.cnpj, razao_social: f.razao_social };
  }
  if (qs.get('tipo')) W.tipo = qs.get('tipo');
  const empresas = S.me.perfil === 'admin' ? await api('GET', '/admin/empresas') : [];

  const passos = ['Dados', 'Clínica', 'Data e horário', 'Confirmação'];
  const desenhar = async () => {
    main.innerHTML = `<h1>Solicitar exame ocupacional</h1><div class="passos">${passos.map((p, i) => `<span class="${i + 1 === W.passo ? 'on' : ''}">${i + 1}. ${p}</span>`).join('')}</div><div id="passo"></div>`;
    const el = $('#passo');
    if (W.passo === 1) return passo1(el);
    if (W.passo === 2) return passo2(el);
    if (W.passo === 3) return passo3(el);
    return passo4(el);
  };

  function passo1(el) {
    const e = W.empresa;
    const f = W.funcionario;
    const leitura = S.me.perfil === 'empresa' ? 'readonly' : '';
    el.innerHTML = `<form id="f1">
      <div class="card"><h2>Dados da empresa</h2>
        ${S.me.perfil === 'admin' ? `<div class="form" style="margin-bottom:12px">${campo({ k: '_emp', rot: 'Empresa cadastrada', tipo: 'select', full: true, opcoes: [['', '— nova empresa / digitar dados —'], ...empresas.map((x) => [x.id, `${x.razao_social} (${fmtCNPJ(x.cnpj)})`])] })}</div>` : ''}
        <div class="form" id="femp">
        ${campo({ k: 'cnpj', rot: 'CNPJ ou CPF', req: true, val: fmtCNPJ(e.cnpj), attrs: `${leitura} inputmode="numeric"` })}${campo({ k: 'razao_social', rot: 'Razão Social', req: true, val: e.razao_social })}
        ${campo({ k: 'responsavel', rot: 'Nome do Responsável', req: true, val: e.responsavel })}${campo({ k: 'telefone', rot: 'Telefone', req: true, val: e.telefone, tipo: 'tel' })}
        ${campo({ k: 'email', rot: 'E-mail', req: true, val: e.email, tipo: 'email' })}</div></div>
      <div class="card"><h2>Dados do funcionário</h2><div class="form" id="ffunc">
        ${campo({ k: 'nome', rot: 'Nome Completo', req: true, val: f.nome })}${campo({ k: 'cpf', rot: 'CPF', req: true, val: fmtCPF(f.cpf), attrs: 'inputmode="numeric"' })}
        ${campo({ k: 'rg', rot: 'RG', req: true, val: f.rg })}${campo({ k: 'telefone', rot: 'Telefone (WhatsApp)', req: true, val: f.telefone, tipo: 'tel' })}
        ${campo({ k: 'data_nascimento', rot: 'Data de Nascimento', req: true, val: f.data_nascimento, tipo: 'date' })}${campo({ k: 'funcao', rot: 'Função/Cargo', req: true, val: f.funcao })}
        ${campo({ k: 'email', rot: 'E-mail do funcionário (opcional)', val: f.email, tipo: 'email' })}</div></div>
      <div class="card"><h2>Tipo de exame (NR-7)</h2>
        <div id="sugestao" class="info hidden" style="margin-bottom:12px"></div>
        <div class="opcoes" id="tipos">${tipos.map((t) => `<button type="button" class="opcao ${W.tipo === t.codigo ? 'sel' : ''}" data-t="${t.codigo}"><strong>${esc(t.nome)}</strong><div class="small muted">${esc(t.descricao || '')}</div></button>`).join('')}</div>
        <div class="form" id="fextra" style="margin-top:12px"><div id="boxNova" class="${W.tipo === 'mudanca_funcao' ? '' : 'hidden'}">${campo({ k: 'funcao_nova', rot: 'Nova função', val: W.funcao_nova })}</div>
        ${campo({ k: 'observacoes', rot: 'Observações para a clínica (opcional)', full: true, val: W.observacoes })}</div>
      </div>
      <div class="acoes" style="justify-content:flex-end"><button class="btn primary">Continuar →</button></div></form>`;
    const selEmp = $('[name=_emp]', el);
    if (selEmp) selEmp.addEventListener('change', () => {
      const x = empresas.find((y) => String(y.id) === selEmp.value);
      if (!x) return;
      for (const k of ['razao_social', 'responsavel', 'telefone', 'email']) $(`#femp [name=${k}]`).value = x[k];
      $('#femp [name=cnpj]').value = fmtCNPJ(x.cnpj);
    });
    $$('#tipos .opcao', el).forEach((b) => b.addEventListener('click', () => {
      W.tipo = b.dataset.t;
      $$('#tipos .opcao', el).forEach((x) => x.classList.toggle('sel', x === b));
      $('#boxNova').classList.toggle('hidden', W.tipo !== 'mudanca_funcao');
    }));
    const sugerir = async () => {
      const cpf = digits($('#ffunc [name=cpf]').value);
      if (cpf.length !== 11) return;
      try {
        const qsS = new URLSearchParams({ cpf, funcao: $('#ffunc [name=funcao]').value, cnpj: digits($('#femp [name=cnpj]').value) });
        const s = await api('GET', `/sugerir-tipo?${qsS}`);
        const t = tipos.find((x) => x.codigo === s.codigo);
        if (!W.tipo) { const b = $(`#tipos [data-t="${s.codigo}"]`); if (b) b.click(); }
        const box = $('#sugestao');
        box.classList.remove('hidden');
        box.innerHTML = `<strong>Identificação automática (NR-7):</strong> ${esc(t ? t.nome : s.codigo)} — ${esc(s.motivo)}
          ${(s.avisos || []).map((a) => `<div class="small">• ${esc(a)}</div>`).join('')}
          ${W.tipo !== s.codigo ? ` <button type="button" class="btn sm" id="usarSug">Usar sugestão</button>` : ''}`;
        const u = $('#usarSug');
        if (u) u.addEventListener('click', () => { const b = $(`#tipos [data-t="${s.codigo}"]`); if (b) b.click(); u.remove(); });
        if (s.funcionario && !$('#ffunc [name=nome]').value) {
          for (const k of ['nome', 'rg', 'telefone', 'data_nascimento', 'email']) if (s.funcionario[k]) $(`#ffunc [name=${k}]`).value = s.funcionario[k];
          if (!$('#ffunc [name=funcao]').value) $('#ffunc [name=funcao]').value = s.funcionario.funcao;
        }
      } catch { /* sugestão é opcional */ }
    };
    $('#ffunc [name=cpf]').addEventListener('blur', sugerir);
    $('#ffunc [name=funcao]').addEventListener('blur', sugerir);
    if (digits(f.cpf).length === 11) sugerir();
    $('#f1').addEventListener('submit', (ev) => {
      ev.preventDefault();
      W.empresa = valoresForm($('#femp'));
      W.funcionario = valoresForm($('#ffunc'));
      const extra = valoresForm($('#fextra'));
      W.funcao_nova = extra.funcao_nova || '';
      W.observacoes = extra.observacoes || '';
      if (!W.tipo) return toast('Selecione o tipo de exame', 'erro');
      if (W.tipo === 'mudanca_funcao' && !W.funcao_nova) return toast('Informe a nova função', 'erro');
      if (digits(W.funcionario.cpf).length !== 11) return toast('CPF deve ter 11 dígitos', 'erro');
      W.passo = 2; desenhar();
    });
  }

  async function passo2(el) {
    const clinicas = await api('GET', `/clinicas?tipo=${W.tipo}`);
    el.innerHTML = `<div class="card"><h2>Clínicas disponíveis</h2><div class="opcoes">${clinicas.map((c) => `<button type="button" class="opcao ${W.clinica && W.clinica.id === c.id ? 'sel' : ''}" data-c="${c.id}">
      <strong>${esc(c.nome)}</strong><div class="small">${esc(c.endereco)}${c.bairro ? ` — ${esc(c.bairro)}` : ''}<br>${esc(c.cidade)}/${esc(c.uf)}</div>
      <div class="small muted">Atendimento ${esc(c.hora_inicio)}–${esc(c.hora_fim)} · ${esc(c.telefone)}</div>
      <div style="margin-top:6px;font-size:18px;font-weight:700">${fmtMoeda(c.valor)}</div>
      <a class="small" target="_blank" rel="noopener" href="${esc(c.maps_url)}">Ver no Google Maps</a></button>`).join('') || '<div class="vazio">Nenhuma clínica disponível.</div>'}</div></div>
      <div class="acoes" style="justify-content:space-between"><button class="btn" id="voltar">← Voltar</button><button class="btn primary" id="seguir">Continuar →</button></div>`;
    $$('.opcao', el).forEach((b) => b.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      W.clinica = clinicas.find((c) => String(c.id) === b.dataset.c);
      W.data = null; W.hora = null;
      $$('.opcao', el).forEach((x) => x.classList.toggle('sel', x === b));
    }));
    $('#voltar').addEventListener('click', () => { W.passo = 1; desenhar(); });
    $('#seguir').addEventListener('click', () => { if (!W.clinica) return toast('Escolha uma clínica', 'erro'); W.passo = 3; desenhar(); });
  }

  async function passo3(el) {
    el.innerHTML = `<div class="card"><h2>${esc(W.clinica.nome)}</h2><p class="muted">${esc(W.clinica.endereco)} — ${esc(W.clinica.cidade)}/${esc(W.clinica.uf)} · ${fmtMoeda(W.clinica.valor)}</p><div id="sdh"></div></div>
      <div class="acoes" style="justify-content:space-between"><button class="btn" id="voltar">← Voltar</button><button class="btn primary" id="seguir">Continuar →</button></div>`;
    $('#voltar').addEventListener('click', () => { W.passo = 2; desenhar(); });
    $('#seguir').addEventListener('click', () => { if (!W.data || !W.hora) return toast('Escolha data e horário', 'erro'); W.passo = 4; desenhar(); });
    await seletorDataHora($('#sdh'), W.clinica.id, W);
  }

  function passo4(el) {
    const t = tipos.find((x) => x.codigo === W.tipo);
    el.innerHTML = `<div class="card"><h2>Confirme o agendamento</h2><dl class="dl">
      <dt>Empresa</dt><dd>${esc(W.empresa.razao_social)} — ${esc(W.empresa.cnpj)}</dd>
      <dt>Funcionário</dt><dd>${esc(W.funcionario.nome)} — CPF ${esc(fmtCPF(W.funcionario.cpf))}</dd>
      <dt>Função</dt><dd>${esc(W.funcionario.funcao)}${W.funcao_nova ? ` → <strong>${esc(W.funcao_nova)}</strong>` : ''}</dd>
      <dt>Tipo de exame</dt><dd>${esc(t.nome)}</dd>
      <dt>Clínica</dt><dd>${esc(W.clinica.nome)}<br><span class="small">${esc(W.clinica.endereco)} — ${esc(W.clinica.cidade)}/${esc(W.clinica.uf)}</span> · <a target="_blank" rel="noopener" href="${esc(W.clinica.maps_url)}">mapa</a></dd>
      <dt>Data e horário</dt><dd><strong>${diaSemana(W.data)}, ${fmtData(W.data)} às ${esc(W.hora)}</strong></dd>
      <dt>Valor do exame</dt><dd><strong style="font-size:18px">${fmtMoeda(W.clinica.valor)}</strong> (pagamento via PIX)</dd></dl></div>
      <div class="aviso" style="margin-bottom:16px">IMPORTANTE: o comprovante de pagamento deverá ser enviado à clínica antes da realização do exame. O funcionário somente será atendido após a confirmação do pagamento.</div>
      <div class="acoes" style="justify-content:space-between"><button class="btn" id="voltar">← Voltar</button><button class="btn primary" id="confirmar">Confirmar agendamento</button></div>`;
    $('#voltar').addEventListener('click', () => { W.passo = 3; desenhar(); });
    $('#confirmar').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Agendando e gerando a guia…';
      try {
        const ag = await api('POST', '/agendamentos', {
          empresa: W.empresa, funcionario: W.funcionario, tipo_exame: W.tipo, funcao_nova: W.funcao_nova,
          clinica_id: W.clinica.id, data: W.data, hora: W.hora, observacoes: W.observacoes,
        });
        sucesso(ag);
      } catch (err) {
        toast(err.message, 'erro');
        e.target.disabled = false;
        e.target.textContent = 'Confirmar agendamento';
        if (/Horário/.test(err.message)) { W.passo = 3; W.hora = null; desenhar(); }
      }
    });
  }

  function sucesso(ag) {
    main.innerHTML = `<h1>Exame agendado ✔</h1>
      <div class="card"><p>Código do agendamento: <strong style="font-size:18px">${esc(ag.codigo)}</strong></p>
      <p>${esc(ag.tipo_nome)} de <strong>${esc(ag.func_nome)}</strong> em <strong>${diaSemana(ag.data)}, ${fmtData(ag.data)} às ${esc(ag.hora)}</strong> — ${esc(ag.clinica_nome)}.</p>
      <p>A guia de encaminhamento em PDF (com QR Code PIX) foi gerada e enviada por e-mail e WhatsApp para a empresa, o funcionário e a clínica.</p>
      <div class="acoes"><button class="btn primary" id="bguia">Baixar guia (PDF)</button><a class="btn" href="#/agendamento/${ag.id}">Ver agendamento / enviar comprovante</a><a class="btn" href="#/novo">Novo agendamento</a></div></div>
      ${ag.pix_payload ? `<div class="card"><h3>PIX — ${fmtMoeda(ag.valor)}</h3><div class="pix-code">${esc(ag.pix_payload)}</div><p><button class="btn sm" id="cpix">Copiar código PIX</button></p></div>` : ''}
      <div class="aviso">IMPORTANTE: o comprovante de pagamento deverá ser enviado à clínica antes da realização do exame. O funcionário somente será atendido após a confirmação do pagamento.<br>
      Envie o comprovante para: WhatsApp ${esc(ag.whatsapp_financeiro || ag.clinica_telefone)} · E-mail ${esc(ag.email_financeiro || ag.clinica_email || '')}</div>`;
    $('#bguia').addEventListener('click', () => baixar(`/agendamentos/${ag.id}/guia`, `Guia ${ag.codigo}.pdf`));
    const c = $('#cpix');
    if (c) c.addEventListener('click', () => navigator.clipboard.writeText(ag.pix_payload).then(() => toast('Código PIX copiado', 'ok')));
  }

  desenhar();
};

/* ================================================================== */
/* Funcionários, histórico, vencimentos e ASOs                          */
/* ================================================================== */

ROTAS.funcionarios = async (main, _a, qs) => {
  const q = qs.get('q') || '';
  const lista = await api('GET', `/funcionarios${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>Funcionários</h1><a class="btn primary" href="#/novo">+ Solicitar exame</a></div>
    <div class="card"><form class="filtros" id="fb">${campo({ k: 'q', rot: 'Buscar por nome ou CPF', val: q })}<button class="btn primary">Buscar</button></form>
    ${tabela([
      ['Nome', (f) => `${esc(f.nome)}<div class="small muted">${esc(fmtCPF(f.cpf))}</div>`],
      ...(S.me.perfil === 'admin' ? [['Empresa', (f) => esc(f.razao_social)]] : []),
      ['Função', (f) => esc(f.funcao)],
      ['Situação', (f) => `<span class="tag ${f.situacao === 'ativo' ? 'ok' : f.situacao === 'afastado' ? 'warn' : 'neutro'}">${esc(f.situacao)}</span>`],
      ['Exame', (f) => (f.vencimento ? tag(SITUACAO_VENC, f.vencimento.situacao) : '<span class="muted">—</span>')],
      ['Validade', (f) => (f.vencimento && f.vencimento.data_validade ? fmtData(f.vencimento.data_validade) : '—')],
    ], lista, { onClick: (f) => ir(`#/funcionario/${f.id}`) })}</div>`;
  $('#fb').addEventListener('submit', (e) => { e.preventDefault(); ir(`#/funcionarios?q=${encodeURIComponent(valoresForm(e.target).q)}`); });
};

ROTAS.funcionario = async (main, [id]) => {
  const f = await api('GET', `/funcionarios/${id}`);
  const v = f.vencimento;
  const pode = ['empresa', 'admin'].includes(S.me.perfil);
  main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>${esc(f.nome)}</h1>
    ${pode ? `<div class="acoes"><a class="btn primary" href="#/novo?funcionario=${f.id}">Agendar exame</a><button class="btn" id="editar">Editar / situação</button></div>` : ''}</div>
    <div class="cols-2"><div class="card"><h3>Dados</h3><dl class="dl">
      <dt>CPF</dt><dd>${esc(fmtCPF(f.cpf))}</dd><dt>RG</dt><dd>${esc(f.rg)}</dd><dt>Nascimento</dt><dd>${fmtData(f.data_nascimento)}</dd>
      <dt>Função atual</dt><dd>${esc(f.funcao)}</dd><dt>Empresa</dt><dd>${esc(f.razao_social)}</dd>
      <dt>Situação</dt><dd>${esc(f.situacao)}${f.data_demissao ? ` em ${fmtData(f.data_demissao)}` : ''}</dd>
      <dt>Admissão</dt><dd>${fmtData(f.data_admissao)}</dd><dt>Contato</dt><dd>${esc(f.telefone)} ${f.email ? `· ${esc(f.email)}` : ''}</dd></dl></div>
    <div class="card"><h3>PCMSO</h3><dl class="dl">
      <dt>Último ASO</dt><dd>${v && v.aso_id ? `${esc(v.tipo_nome)} em ${fmtData(v.data_emissao)}` : 'Nenhum'}</dd>
      <dt>Próximo periódico</dt><dd>${v && v.data_validade ? `${fmtData(v.data_validade)} ${tag(SITUACAO_VENC, v.situacao)}` : '—'}</dd>
      <dt>Agendamento futuro</dt><dd>${esc((v && v.proximo_agendamento) || '—')}</dd></dl></div></div>
    <div class="card"><h3>ASOs emitidos</h3>${tabela([
      ['Emissão', (s) => fmtData(s.data_emissao)], ['Tipo', (s) => esc(s.tipo_nome)], ['Função', (s) => esc(s.funcao)], ['Conclusão', (s) => tag(CONCLUSAO, s.conclusao)],
      ['Validade', (s) => fmtData(s.data_validade)], ['Assinatura', (s) => (s.hash_assinatura ? '<span class="tag ok">Assinado</span>' : '<span class="tag warn">Pendente</span>')],
      ['', (s) => `<button class="btn sm" data-aso-pdf="${s.id}">Baixar ASO</button>`],
    ], f.asos, { vazio: 'Nenhum ASO emitido.' })}</div>
    <div class="cols-2"><div class="card"><h3>Histórico ocupacional</h3>${f.historico.length ? `<ul class="timeline">${f.historico.map((h) => `<li><strong>${fmtData(h.data)}</strong> — ${esc(EVENTOS[h.evento] || h.evento)}
      <div class="small muted">${esc(h.descricao || '')}${h.funcao_anterior ? ` (${esc(h.funcao_anterior)} → ${esc(h.funcao_nova)})` : ''}</div></li>`).join('')}</ul>` : '<div class="vazio">Sem eventos.</div>'}</div>
    <div class="card"><h3>Exames</h3>${tabela([['Data', (a) => fmtData(a.data)], ['Exame', (a) => esc(a.tipo_nome)], ['Status', (a) => tag(STATUS, a.status)]], f.agendamentos, { onClick: abrirAg, vazio: 'Nenhum exame.' })}</div></div>`;
  ligarASO();
  const ed = $('#editar');
  if (ed) ed.addEventListener('click', () => modal('Editar funcionário', `<div class="form">
    ${campo({ k: 'nome', rot: 'Nome', val: f.nome, req: true })}${campo({ k: 'rg', rot: 'RG', val: f.rg })}${campo({ k: 'telefone', rot: 'Telefone', val: f.telefone })}
    ${campo({ k: 'email', rot: 'E-mail', val: f.email || '' })}${campo({ k: 'data_nascimento', rot: 'Nascimento', tipo: 'date', val: f.data_nascimento })}
    ${campo({ k: 'situacao', rot: 'Situação', tipo: 'select', val: f.situacao, opcoes: [['ativo', 'Ativo'], ['afastado', 'Afastado (exige exame de retorno)'], ['demitido', 'Demitido']] })}
    </div><p class="muted small">A função é alterada pelo exame de Mudança de Função, para manter o histórico do PCMSO.</p>`, {
    onConfirm: async (m) => { await api('PUT', `/funcionarios/${f.id}`, valoresForm(m)); toast('Funcionário atualizado', 'ok'); render(); },
  }));
};

ROTAS.vencimentos = async (main, _a, qs) => {
  const filtro = qs.get('s') || '';
  const lista = (await api('GET', '/vencimentos')).filter((v) => !filtro || v.situacao === filtro);
  main.innerHTML = `<h1>Vencimentos de exames</h1><div class="card"><div class="acoes" style="margin-bottom:12px">
    ${[['', 'Todos'], ['vencido', 'Vencidos'], ['a_vencer', 'A vencer (90 dias)'], ['sem_aso', 'Sem ASO'], ['em_dia', 'Em dia']].map(([k, t]) => `<a class="btn sm ${filtro === k ? 'primary' : ''}" href="#/vencimentos${k ? `?s=${k}` : ''}">${t}</a>`).join('')}</div>
    ${tabela([
      ['Funcionário', (v) => `${esc(v.nome)}<div class="small muted">${esc(v.funcao)}</div>`],
      ...(S.me.perfil === 'admin' ? [['Empresa', (v) => esc(v.razao_social)]] : []),
      ['Último ASO', (v) => (v.aso_id ? `${esc(v.tipo_nome)}<div class="small muted">${fmtData(v.data_emissao)}</div>` : '—')],
      ['Validade', (v) => (v.data_validade ? `${fmtData(v.data_validade)}<div class="small muted">${v.dias_para_vencer < 0 ? `vencido há ${-v.dias_para_vencer} dias` : `em ${v.dias_para_vencer} dias`}</div>` : '—')],
      ['Situação', (v) => tag(SITUACAO_VENC, v.situacao)],
      ['Agendamento', (v) => esc(v.proximo_agendamento || '—')],
      ['', (v) => (['empresa', 'admin'].includes(S.me.perfil) && !v.proximo_agendamento ? `<a class="btn sm primary" href="#/novo?funcionario=${v.funcionario_id}&tipo=periodico">Agendar</a>` : '')],
    ], lista, { onClick: (v) => ir(`#/funcionario/${v.funcionario_id}`) })}</div>`;
};

ROTAS.asos = async (main) => {
  const pend = S.me.perfil === 'medico';
  const lista = await api('GET', '/asos');
  main.innerHTML = `<h1>${S.me.perfil === 'empresa' ? 'ASOs e documentos' : 'ASOs'}</h1>
    ${pend ? `<div class="card"><h3>Aguardando sua assinatura</h3>${tabela(colAsos(true), lista.filter((s) => !s.hash_assinatura), { vazio: 'Nenhum ASO pendente de assinatura.' })}</div>` : ''}
    <div class="card">${tabela(colAsos(false), lista, { onClick: (s) => ir(`#/agendamento/${s.agendamento_id}`) })}</div>`;
  ligarASO();
};
function colAsos(assinar) {
  return [
    ['Emissão', (s) => fmtData(s.data_emissao)],
    ['Funcionário', (s) => `${esc(s.func_nome)}<div class="small muted">${esc(fmtCPF(s.func_cpf))}</div>`],
    ['Empresa', (s) => esc(s.razao_social)], ['Tipo', (s) => esc(s.tipo_nome)], ['Conclusão', (s) => tag(CONCLUSAO, s.conclusao)],
    ['Validade', (s) => fmtData(s.data_validade)],
    ['Assinatura', (s) => (s.hash_assinatura ? '<span class="tag ok">Assinado</span>' : '<span class="tag warn">Pendente</span>')],
    ['', (s) => `<div class="acoes"><button class="btn sm" data-aso-pdf="${s.id}">PDF</button>${assinar ? `<button class="btn sm ok" data-assinar="${s.id}">Assinar</button>` : ''}</div>`],
  ];
}

/* ================================================================== */
/* Administração                                                        */
/* ================================================================== */

function crudPage({ titulo, endpoint, colunas, campos, novo = true, depoisCarregar, extraTopo }) {
  return async (main) => {
    const extras = depoisCarregar ? await depoisCarregar() : {};
    const lista = await api('GET', endpoint);
    const cs = typeof campos === 'function' ? campos(extras) : campos;
    main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>${esc(titulo)}</h1><div class="acoes">${extraTopo ? await extraTopo() : ''}${novo ? '<button class="btn primary" id="novo">+ Novo</button>' : ''}</div></div>
      <div class="card">${tabela(colunas.map(([r, fn]) => [r, (l) => fn(l, extras)]), lista, { onClick: (l) => abrir(l) })}</div>`;
    const abrir = (reg) => modal(reg ? `Editar — ${titulo}` : `Novo — ${titulo}`,
      `<div class="form">${cs.map((c) => campo({ ...c, val: reg ? (c.k === 'senha' ? '' : reg[c.k]) : c.padrao ?? '', req: c.req && !(reg && c.k === 'senha'), rot: reg && c.k === 'senha' ? 'Nova senha (deixe em branco para manter)' : c.rot })).join('')}</div>`, {
      largura: 760,
      onConfirm: async (m) => {
        const dados = valoresForm(m);
        if (reg && dados.senha === '') delete dados.senha;
        await api(reg ? 'PUT' : 'POST', reg ? `${endpoint}/${reg.id}` : endpoint, dados);
        toast('Salvo', 'ok');
        render();
      },
    });
    const n = $('#novo');
    if (n) n.addEventListener('click', () => abrir(null));
  };
}
const ativoOp = [['1', 'Ativo'], ['0', 'Inativo']];
const ativoTag = (l) => (l.ativo ? '<span class="tag ok">Ativo</span>' : '<span class="tag neutro">Inativo</span>');

ROTAS.empresas = crudPage({
  titulo: 'Empresas', endpoint: '/admin/empresas',
  extraTopo: async () => {
    const s = await api('GET', '/admin/esocial/sincronizacao').catch(() => null);
    if (!s || !s.configurado) return '';
    const u = s.ultima;
    const info = u ? `Última: ${new Date(u.em).toLocaleString('pt-BR')} · ${u.novas} nova(s), ${u.atualizadas} atualizada(s)` : 'Ainda não sincronizado';
    return `<span class="small muted" title="Todo dia às ${esc(s.hora)} o sistema puxa do eSocial Brasil só as empresas novas ou alteradas">eSocial: ${esc(info)}</span>
      <button class="btn" data-sync-esocial>Sincronizar agora</button>`;
  },
  colunas: [['Razão social', (l) => esc(l.razao_social)], ['CNPJ / CPF', (l) => esc(fmtCNPJ(l.cnpj))], ['Responsável', (l) => esc(l.responsavel)], ['Contato', (l) => `${esc(l.telefone)}<div class="small muted">${esc(l.email)}</div>`], ['', ativoTag],
    ['Acesso', (l) => (l.acesso_login ? `${l.acesso_pendente ? '<span class="tag warn">Aguardando 1º acesso</span>' : '<span class="tag ok">Senha criada</span>'}<div class="small muted">login ${esc(fmtCNPJ(l.acesso_login))}</div>` : '<span class="tag neutro">—</span>')],
    ['', (l) => `<button class="btn" data-riscos="${l.id}">Riscos por função</button> <button class="btn" data-redefinir="${l.id}">Redefinir senha</button>`]],
  campos: [{ k: 'cnpj', rot: 'CNPJ ou CPF', req: true }, { k: 'razao_social', rot: 'Razão Social', req: true }, { k: 'responsavel', rot: 'Responsável', req: true },
    { k: 'telefone', rot: 'Telefone', req: true }, { k: 'email', rot: 'E-mail', tipo: 'email', req: true }, { k: 'ativo', rot: 'Situação', tipo: 'select', opcoes: ativoOp, padrao: '1' }],
});

/* Riscos ocupacionais por função (PGR) da empresa */
const CAT_RISCO = [['fisicos', 'Físicos'], ['quimicos', 'Químicos'], ['biologicos', 'Biológicos'], ['ergonomicos', 'Ergonômicos'], ['acidentes', 'Acidentes']];

async function modalRiscos(empresaId) {
  const d = await api('GET', `/admin/empresas/${empresaId}/riscos`);
  const resumo = (f) => CAT_RISCO.filter(([k]) => f[k]).map(([k, r]) => `<b>${r}:</b> ${esc(f[k])}`).join('<br>') || '<span class="tag warn">Sem riscos — sai em branco</span>';
  const corpo = `<p class="muted small">Quando a função do funcionário estiver aqui, a guia e o ASO já saem com estes riscos. Função sem cadastro sai com os riscos em branco.</p>
    <div class="acoes" style="margin-bottom:10px">
      <button class="btn primary" id="rf-novo">+ Nova função</button>
      ${d.esocial ? '<button class="btn" id="rf-imp">Trazer funções do eSocial Brasil</button>' : '<span class="small muted">eSocial Brasil não configurado (ESOCIAL_TOKEN)</span>'}
    </div>
    ${tabela([
      ['Função', (f) => `${esc(f.funcao)}${f.origem === 'esocial' ? '<div class="small muted">vinda do eSocial</div>' : ''}`],
      ['Riscos', resumo],
      ['', (f) => `<button class="btn" data-rf-del="${f.id}">Excluir</button>`],
    ], d.funcoes, { onClick: (f) => editar(f), vazio: 'Nenhuma função cadastrada.' })}`;
  const m = modal(`Riscos por função — ${d.empresa.razao_social}`, corpo, { largura: 860 });
  const reabrir = () => { m.fechar(); modalRiscos(empresaId); };
  const editar = (f) => modal(f ? `Riscos — ${f.funcao}` : 'Nova função', `<div class="form">
      ${campo({ k: 'funcao', rot: 'Função', req: true, full: true, val: f ? f.funcao : '' })}
      ${CAT_RISCO.map(([k, r]) => campo({ k, rot: `Riscos ${r.toLowerCase()}`, tipo: 'textarea', full: true, val: f ? f[k] : '' })).join('')}
    </div>`, {
    largura: 720,
    onConfirm: async (mm) => { await api('POST', `/admin/empresas/${empresaId}/riscos`, valoresForm(mm)); toast('Riscos salvos', 'ok'); reabrir(); },
  });
  $('#rf-novo', m.el).addEventListener('click', () => editar(null));
  const imp = $('#rf-imp', m.el);
  if (imp) imp.addEventListener('click', async () => {
    imp.disabled = true;
    try {
      const r = await api('POST', `/admin/empresas/${empresaId}/riscos/importar-esocial`);
      toast(`${r.encontradas} função(ões) no eSocial, ${r.novas} nova(s). Preencha os riscos de cada uma.`, 'ok');
      reabrir();
    } catch (e) { toast(e.message, 'erro'); imp.disabled = false; }
  });
  $$('[data-rf-del]', m.el).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Excluir esta função do cadastro de riscos?')) return;
    await api('DELETE', `/admin/empresas/${empresaId}/riscos/${b.dataset.rfDel}`);
    reabrir();
  }));
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-riscos]');
  if (b) { e.stopPropagation(); modalRiscos(b.dataset.riscos).catch((err) => toast(err.message, 'erro')); }
  const sy = e.target.closest('[data-sync-esocial]');
  if (sy) {
    sy.disabled = true; sy.textContent = 'Sincronizando…';
    api('POST', '/admin/esocial/sincronizar')
      .then((x) => { toast(`eSocial: ${x.recebidas} empresas lidas · ${x.novas} nova(s) · ${x.atualizadas} atualizada(s) · ${x.sem_mudanca} sem mudança`, 'ok'); render(); })
      .catch((err) => { toast(err.message, 'erro'); sy.disabled = false; sy.textContent = 'Sincronizar agora'; });
  }
  const r = e.target.closest('[data-redefinir]');
  if (r) {
    e.stopPropagation();
    if (!confirm('Voltar o acesso desta empresa para a senha inicial? Ela terá de criar uma nova senha no próximo acesso.')) return;
    api('POST', `/admin/empresas/${r.dataset.redefinir}/acesso/redefinir`)
      .then((x) => { toast(`Acesso redefinido. Login: ${fmtCNPJ(x.login)}`, 'ok'); render(); })
      .catch((err) => toast(err.message, 'erro'));
  }
});

ROTAS.clinicas = crudPage({
  titulo: 'Clínicas', endpoint: '/admin/clinicas',
  colunas: [['Nome', (l) => esc(l.nome)], ['Endereço', (l) => `${esc(l.endereco)}<div class="small muted">${esc(l.cidade)}/${esc(l.uf)}</div>`], ['Horário', (l) => `${esc(l.hora_inicio)}–${esc(l.hora_fim)} · ${l.intervalo_min} min · ${l.capacidade_horario}/horário`], ['PIX', (l) => esc(l.pix_chave || 'padrão do sistema')], ['', ativoTag]],
  campos: [
    { k: 'nome', rot: 'Nome', req: true }, { k: 'cnpj', rot: 'CNPJ' }, { k: 'endereco', rot: 'Endereço', req: true, full: true }, { k: 'bairro', rot: 'Bairro' },
    { k: 'cidade', rot: 'Cidade', req: true }, { k: 'uf', rot: 'UF', req: true }, { k: 'cep', rot: 'CEP' }, { k: 'telefone', rot: 'Telefone', req: true }, { k: 'email', rot: 'E-mail' },
    { k: 'whatsapp_financeiro', rot: 'WhatsApp para comprovantes' }, { k: 'email_financeiro', rot: 'E-mail financeiro' }, { k: 'maps_url', rot: 'Link Google Maps (opcional)', full: true },
    { k: 'pix_chave', rot: 'Chave PIX da clínica (vazio = padrão)' }, { k: 'pix_nome', rot: 'Nome do favorecido PIX' }, { k: 'pix_cidade', rot: 'Cidade do favorecido PIX' },
    { k: 'hora_inicio', rot: 'Início do atendimento', tipo: 'time', padrao: '07:00' }, { k: 'hora_fim', rot: 'Fim do atendimento', tipo: 'time', padrao: '17:00' },
    { k: 'intervalo_min', rot: 'Intervalo entre horários (min)', tipo: 'number', padrao: '20' }, { k: 'capacidade_horario', rot: 'Atendimentos por horário', tipo: 'number', padrao: '1' },
    { k: 'dias_semana', rot: 'Dias de atendimento (0=dom … 6=sáb)', padrao: '1,2,3,4,5' }, { k: 'ativo', rot: 'Situação', tipo: 'select', opcoes: ativoOp, padrao: '1' },
  ],
});

const carregarClinicas = async () => ({ clinicas: await api('GET', '/admin/clinicas') });
ROTAS.medicos = crudPage({
  titulo: 'Médicos', endpoint: '/admin/medicos', depoisCarregar: carregarClinicas,
  colunas: [['Nome', (l) => esc(l.nome)], ['CRM', (l) => `${esc(l.crm)}/${esc(l.uf_crm)}`], ['Clínica', (l, x) => esc((x.clinicas.find((c) => c.id === l.clinica_id) || {}).nome || '—')], ['Contato', (l) => esc(l.email || '')], ['', ativoTag]],
  campos: (x) => [{ k: 'nome', rot: 'Nome', req: true }, { k: 'crm', rot: 'CRM', req: true }, { k: 'uf_crm', rot: 'UF do CRM', req: true },
    { k: 'clinica_id', rot: 'Clínica', tipo: 'select', req: true, opcoes: [['', 'Selecione…'], ...x.clinicas.map((c) => [c.id, c.nome])] },
    { k: 'email', rot: 'E-mail', tipo: 'email' }, { k: 'telefone', rot: 'Telefone' }, { k: 'ativo', rot: 'Situação', tipo: 'select', opcoes: ativoOp, padrao: '1' }],
});

ROTAS.usuarios = crudPage({
  titulo: 'Usuários', endpoint: '/admin/usuarios',
  depoisCarregar: async () => ({ clinicas: await api('GET', '/admin/clinicas'), empresas: await api('GET', '/admin/empresas'), medicos: await api('GET', '/admin/medicos') }),
  colunas: [['Nome', (l) => esc(l.nome)], ['E-mail', (l) => esc(l.email)], ['Perfil', (l) => `<span class="tag">${esc(PERFIL_NOME[l.perfil])}</span>`], ['Vínculo', (l) => esc(l.razao_social || l.medico_nome || l.clinica_nome || '—')], ['', ativoTag]],
  campos: (x) => [
    { k: 'nome', rot: 'Nome', req: true }, { k: 'email', rot: 'E-mail (login)', tipo: 'email', req: true }, { k: 'senha', rot: 'Senha (mín. 6)', tipo: 'password', req: true },
    { k: 'perfil', rot: 'Perfil', tipo: 'select', req: true, opcoes: Object.entries(PERFIL_NOME) },
    { k: 'empresa_id', rot: 'Empresa (perfil Empresa)', tipo: 'select', opcoes: [['', '—'], ...x.empresas.map((e) => [e.id, e.razao_social])] },
    { k: 'clinica_id', rot: 'Clínica (perfil Clínica)', tipo: 'select', opcoes: [['', '—'], ...x.clinicas.map((c) => [c.id, c.nome])] },
    { k: 'medico_id', rot: 'Médico (perfil Médico)', tipo: 'select', opcoes: [['', '—'], ...x.medicos.map((m) => [m.id, `${m.nome} — CRM ${m.crm}`])] },
    { k: 'ativo', rot: 'Situação', tipo: 'select', opcoes: ativoOp, padrao: '1' },
  ],
});

ROTAS.tipos = crudPage({
  titulo: 'Tipos de exame', endpoint: '/admin/tipos-exame',
  colunas: [['Nome', (l) => `${esc(l.nome)}<div class="small muted">${esc(l.codigo)}</div>`], ['Categoria', (l) => `<span class="tag ${l.categoria === 'ocupacional' ? '' : 'neutro'}">${esc(l.categoria)}</span>`], ['Valor padrão', (l) => fmtMoeda(l.valor_padrao), 'num'], ['Validade do ASO', (l) => (l.validade_meses ? `${l.validade_meses} meses` : '—')], ['', ativoTag]],
  campos: [{ k: 'codigo', rot: 'Código (sem espaços)', req: true }, { k: 'nome', rot: 'Nome', req: true },
    { k: 'categoria', rot: 'Categoria', tipo: 'select', opcoes: [['complementar', 'Exame complementar'], ['ocupacional', 'Exame ocupacional (NR-7)']] },
    { k: 'valor_padrao', rot: 'Valor padrão (R$)', tipo: 'number', attrs: 'step="0.01" min="0"' }, { k: 'validade_meses', rot: 'Validade do ASO (meses)', tipo: 'number' },
    { k: 'descricao', rot: 'Descrição', tipo: 'textarea', full: true }, { k: 'ativo', rot: 'Situação', tipo: 'select', opcoes: ativoOp, padrao: '1' }],
});

ROTAS.precos = async (main) => {
  const linhas = await api('GET', '/admin/precos');
  const porClinica = {};
  for (const l of linhas) (porClinica[l.clinica_nome] = porClinica[l.clinica_nome] || []).push(l);
  main.innerHTML = `<h1>Valores dos exames</h1><p class="muted">Deixe em branco para usar o valor padrão do tipo de exame. As alterações são salvas ao sair do campo.</p>
    ${Object.entries(porClinica).map(([nome, ls]) => `<div class="card"><h3>${esc(nome)}</h3>${tabela([
      ['Exame', (l) => `${esc(l.tipo_nome)} <span class="small muted">${esc(l.categoria)}</span>`], ['Padrão', (l) => fmtMoeda(l.valor_padrao), 'num'],
      ['Valor nesta clínica (R$)', (l) => `<input type="number" step="0.01" min="0" style="max-width:140px;margin:0" data-c="${l.clinica_id}" data-t="${l.tipo_exame_id}" value="${l.valor ?? ''}" placeholder="${l.valor_padrao}">`],
    ], ls)}</div>`).join('')}`;
  $$('input[data-c]', main).forEach((i) => i.addEventListener('change', async () => {
    try { await api('PUT', '/admin/precos', { clinica_id: i.dataset.c, tipo_exame_id: i.dataset.t, valor: i.value }); toast('Valor salvo', 'ok'); } catch (e) { toast(e.message, 'erro'); }
  }));
};

ROTAS.pix = async (main) => {
  const c = await api('GET', '/admin/config');
  main.innerHTML = `<h1>Configurar PIX</h1><div class="card"><p class="muted">Dados padrão usados na guia de encaminhamento quando a clínica não tem PIX próprio. O QR Code segue o padrão BR Code do Banco Central, com o valor do exame e o código do agendamento.</p>
    <form id="fp" class="form">${campo({ k: 'pix_chave', rot: 'Chave PIX (CPF/CNPJ, e-mail, telefone +55… ou aleatória)', val: c.pix_chave, req: true, full: true })}
    ${campo({ k: 'pix_nome', rot: 'Nome do favorecido (até 25 caracteres)', val: c.pix_nome, req: true })}${campo({ k: 'pix_cidade', rot: 'Cidade do favorecido (até 15)', val: c.pix_cidade, req: true })}
    ${campo({ k: 'whatsapp_financeiro', rot: 'WhatsApp para comprovantes', val: c.whatsapp_financeiro })}${campo({ k: 'email_financeiro', rot: 'E-mail para comprovantes', val: c.email_financeiro, tipo: 'email' })}
    <div class="full"><button class="btn primary">Salvar</button></div></form></div>`;
  $('#fp').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('PUT', '/admin/config', valoresForm(e.target)); toast('Configuração salva', 'ok'); } catch (err) { toast(err.message, 'erro'); } });
};

ROTAS.faturamento = async (main, _a, qs) => {
  const de = qs.get('de') || `${hojeISO().slice(0, 7)}-01`;
  const ate = qs.get('ate') || hojeISO();
  const f = await api('GET', `/admin/faturamento?de=${de}&ate=${ate}`);
  const t = (ls) => tabela([['Nome', (l) => esc(l.nome)], ['Exames', (l) => l.exames, 'num'], ['Confirmado', (l) => fmtMoeda(l.confirmado), 'num'], ...(ls[0] && 'pendente' in ls[0] ? [['A receber', (l) => fmtMoeda(l.pendente), 'num']] : [])], ls);
  main.innerHTML = `<h1>Faturamento</h1><div class="card"><form class="filtros" id="ff">${campo({ k: 'de', rot: 'De', tipo: 'date', val: de })}${campo({ k: 'ate', rot: 'Até', tipo: 'date', val: ate })}<button class="btn primary">Aplicar</button></form>
    <div class="kpis">${kpi('Recebido (pagamentos confirmados)', fmtMoeda(f.total_confirmado))}${kpi('A receber', fmtMoeda(f.total_pendente))}</div></div>
    <div class="cols-2"><div class="card"><h3>Por clínica</h3>${t(f.por_clinica)}</div><div class="card"><h3>Por tipo de exame</h3>${t(f.por_tipo)}</div></div>
    <div class="card"><h3>Por empresa</h3>${t(f.por_empresa)}</div>`;
  $('#ff').addEventListener('submit', (e) => { e.preventDefault(); const v = valoresForm(e.target); ir(`#/faturamento?de=${v.de}&ate=${v.ate}`); });
};

ROTAS.relatorios = async (main, _a, qs) => {
  const tipo = qs.get('tipo') || 'agendamentos';
  const de = qs.get('de') || addDiasISO(hojeISO(), -30);
  const ate = qs.get('ate') || hojeISO();
  const rows = await api('GET', `/admin/relatorios/${tipo}?de=${de}&ate=${ate}`);
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  main.innerHTML = `<h1>Relatórios</h1><div class="card"><form class="filtros" id="fr">
    ${campo({ k: 'tipo', rot: 'Relatório', tipo: 'select', val: tipo, opcoes: [['agendamentos', 'Agendamentos'], ['asos', 'ASOs emitidos'], ['vencimentos', 'Vencimentos (PCMSO)']] })}
    ${campo({ k: 'de', rot: 'De', tipo: 'date', val: de })}${campo({ k: 'ate', rot: 'Até', tipo: 'date', val: ate })}
    <button class="btn primary">Gerar</button><button type="button" class="btn" id="csv">Exportar CSV</button></form>
    <p class="muted small">${rows.length} registro(s)</p>${tabela(cols.map((c) => [c.replace(/_/g, ' '), (r) => esc(r[c] ?? '')]), rows.slice(0, 500))}</div>`;
  $('#fr').addEventListener('submit', (e) => { e.preventDefault(); ir(`#/relatorios?${new URLSearchParams(valoresForm(e.target))}`); });
  $('#csv').addEventListener('click', () => baixar(`/admin/relatorios/${tipo}?de=${de}&ate=${ate}&formato=csv`, `relatorio-${tipo}.csv`));
};

ROTAS.notificacoes = async (main) => {
  const ns = await api('GET', '/admin/notificacoes');
  main.innerHTML = `<div class="acoes" style="justify-content:space-between;align-items:center"><h1>Envios e alertas</h1><button class="btn primary" id="rodar">Executar alertas agora</button></div>
    <div class="info" style="margin-bottom:16px">Alertas automáticos: vencimento de exames 90, 60, 30 e 15 dias antes; lembretes de agendamento 72h, 24h e 2h antes — por e-mail e WhatsApp.
    Status <strong>simulado</strong> = canal ainda não configurado (defina SMTP e WhatsApp no arquivo .env).</div>
    <div class="card">${tabela([['Quando', (n) => esc(n.created_at)], ['Canal', (n) => esc(n.canal)], ['Destino', (n) => esc(n.destino)], ['Assunto', (n) => esc(n.assunto || '')],
      ['Status', (n) => `<span class="tag ${n.status === 'enviado' ? 'ok' : n.status === 'erro' ? 'danger' : 'neutro'}">${esc(n.status)}</span>${n.erro ? `<div class="small muted">${esc(n.erro)}</div>` : ''}`]], ns,
      { onClick: (n) => modal(n.assunto || 'Mensagem', `<p class="muted">${esc(n.canal)} → ${esc(n.destino)}</p><pre style="white-space:pre-wrap;font:inherit">${esc(n.mensagem)}</pre>`) })}</div>`;
  $('#rodar').addEventListener('click', async () => {
    try { const r = await api('POST', '/admin/alertas/executar'); toast(`Vencimentos: ${r.vencimentos} · Lembretes: ${r.lembretes} · Ausentes: ${r.ausentes}`, 'ok'); render(); } catch (e) { toast(e.message, 'erro'); }
  });
};

ROTAS.senha = async (main) => {
  main.innerHTML = `<h1>Alterar senha</h1><div class="card" style="max-width:480px"><form id="fs" class="grid">
    ${campo({ k: 'atual', rot: 'Senha atual', tipo: 'password', req: true })}${campo({ k: 'nova', rot: 'Nova senha (mín. 6)', tipo: 'password', req: true })}<button class="btn primary">Salvar</button></form></div>`;
  $('#fs').addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/auth/senha', valoresForm(e.target)); toast('Senha alterada', 'ok'); e.target.reset(); } catch (err) { toast(err.message, 'erro'); } });
};

/* ================================================================== */
/* Verificação pública de ASO                                           */
/* ================================================================== */

async function pgVerificar(hash) {
  $('#app').innerHTML = '<div class="login"><div class="login-card"><span class="logo-chip"><img src="/img/logo.png" alt="UrbanClin"></span><div id="ver"><p class="muted">Verificando…</p></div></div></div>';
  try {
    const r = await (await fetch(`/api/verificar/${encodeURIComponent(hash || '')}`)).json();
    $('#ver').innerHTML = `<h2 style="text-align:center">Verificação de ASO</h2>${r.valido
      ? `<p><span class="tag ok">Assinatura válida</span></p><dl class="dl"><dt>ASO</dt><dd>nº ${esc(r.aso)} — ${esc(r.tipo)}</dd><dt>Trabalhador</dt><dd>${esc(r.trabalhador)}</dd>
        <dt>Empresa</dt><dd>${esc(r.empresa)}</dd><dt>Conclusão</dt><dd>${tag(CONCLUSAO, r.conclusao)}</dd><dt>Emissão</dt><dd>${fmtData(r.emissao)}</dd>
        <dt>Validade</dt><dd>${fmtData(r.validade)}</dd><dt>Médico</dt><dd>${esc(r.medico)} — CRM ${esc(r.crm)}</dd><dt>Assinado em</dt><dd>${esc(r.assinado_em)}</dd></dl>`
      : '<p><span class="tag danger">Código não encontrado</span></p><p class="muted">Este código de verificação não corresponde a nenhum ASO assinado.</p>'}
      <p><a href="#/dashboard">Ir para o sistema</a></p>`;
  } catch { $('#ver').innerHTML += '<p class="aviso">Não foi possível verificar agora.</p>'; }
}
