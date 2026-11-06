'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR, UPLOAD_DIR } = require('../db');
const { autenticar, perfil, confereSenha, emitirToken, hashSenha } = require('../auth');
const { h, httpError, hoje, addDias, agoraISO, digits } = require('../util');
const S = require('../services');
const notify = require('../notify');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase().slice(0, 6)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : httpError(400, 'Envie um arquivo PDF, JPG, PNG ou WEBP'), ok);
  },
});

/* ------------------------------------------------------------------ */
/* Público                                                              */
/* ------------------------------------------------------------------ */

router.post('/auth/login', h(async (req, res) => {
  const { login, email, senha } = req.body || {};
  const u = await S.entrar(login ?? email, senha);
  res.json({ token: emitirToken(u), usuario: { id: u.id, nome: u.nome, email: u.email, login: u.login, perfil: u.perfil, trocar_senha: !!u.trocar_senha } });
}));

/** Verificação pública da assinatura eletrônica de um ASO. */
router.get('/verificar/:hash', h((req, res) => {
  const a = db.prepare('SELECT id FROM asos WHERE hash_assinatura = ?').get(String(req.params.hash));
  if (!a) return res.json({ valido: false });
  const aso = S.buscarASO(a.id);
  const mascara = (n) => n.split(' ').map((p, i) => (i === 0 ? p : `${p[0]}.`)).join(' ');
  res.json({
    valido: true,
    aso: String(aso.id).padStart(6, '0'), tipo: aso.tipo_nome, trabalhador: mascara(aso.func_nome), empresa: aso.razao_social,
    conclusao: aso.conclusao, emissao: aso.data_emissao, validade: aso.data_validade,
    medico: aso.medico_nome, crm: `${aso.medico_crm}/${aso.medico_uf_crm}`, assinado_em: aso.assinado_em,
  });
}));

router.use(autenticar);

/* ------------------------------------------------------------------ */
/* Sessão                                                               */
/* ------------------------------------------------------------------ */

router.get('/auth/me', h((req, res) => {
  const u = req.user;
  const extra = {};
  if (u.empresa_id) extra.empresa = db.prepare('SELECT * FROM empresas WHERE id = ?').get(u.empresa_id);
  if (u.clinica_id) extra.clinica = db.prepare('SELECT id, nome, cidade, uf FROM clinicas WHERE id = ?').get(u.clinica_id);
  if (u.medico_id) extra.medico = db.prepare('SELECT id, nome, crm, uf_crm FROM medicos WHERE id = ?').get(u.medico_id);
  res.json({ ...u, ...extra });
}));

router.post('/auth/senha', h((req, res) => {
  const { atual, nova } = req.body || {};
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(req.user.id);
  if (!confereSenha(atual || '', u.senha_hash)) throw httpError(400, 'Senha atual incorreta');
  if (String(nova || '').length < 6) throw httpError(400, 'A nova senha deve ter ao menos 6 caracteres');
  if (String(nova) === S.SENHA_INICIAL()) throw httpError(400, 'A nova senha não pode ser igual à senha inicial');
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?').run(hashSenha(nova), u.id);
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Catálogo e disponibilidade                                           */
/* ------------------------------------------------------------------ */

router.get('/tipos-exame', h((req, res) => {
  res.json(db.prepare('SELECT * FROM tipos_exame WHERE ativo = 1 ORDER BY categoria DESC, id').all());
}));

router.get('/clinicas', h((req, res) => {
  const tipo = req.query.tipo ? S.tipoPorCodigoOuId(req.query.tipo) : null;
  res.json(S.clinicasDisponiveis(tipo && tipo.id, req.query.cidade));
}));

router.get('/clinicas/:id/datas', h((req, res) => {
  res.json(S.datasDisponiveis(Number(req.params.id), Math.min(Number(req.query.dias || 30), 90)));
}));

router.get('/clinicas/:id/horarios', h((req, res) => {
  res.json(S.horariosDisponiveis(Number(req.params.id), String(req.query.data || '')));
}));

router.get('/sugerir-tipo', perfil('empresa', 'admin'), h((req, res) => {
  const empresaId = req.user.perfil === 'empresa'
    ? req.user.empresa_id
    : (db.prepare('SELECT id FROM empresas WHERE cnpj = ?').get(digits(req.query.cnpj)) || {}).id;
  if (!empresaId) return res.json({ codigo: 'admissional', motivo: 'Empresa ainda não cadastrada.', avisos: [] });
  res.json(S.sugerirTipo(empresaId, req.query.cpf, req.query.funcao));
}));

router.get('/medicos', perfil('admin', 'clinica', 'medico'), h((req, res) => {
  const clinica = req.user.perfil === 'admin' ? req.query.clinica_id : req.user.clinica_id || S.clinicaDoMedico(req.user.medico_id);
  const rows = clinica
    ? db.prepare('SELECT * FROM medicos WHERE clinica_id = ? AND ativo = 1 ORDER BY nome').all(Number(clinica))
    : db.prepare('SELECT * FROM medicos WHERE ativo = 1 ORDER BY nome').all();
  res.json(rows);
}));

/* ------------------------------------------------------------------ */
/* Agendamentos                                                         */
/* ------------------------------------------------------------------ */

function escopoAgendamentos(user) {
  switch (user.perfil) {
    case 'empresa': return ['a.empresa_id = ?', [user.empresa_id]];
    case 'clinica': return ['a.clinica_id = ?', [user.clinica_id]];
    case 'medico': return ['a.clinica_id = ?', [S.clinicaDoMedico(user.medico_id)]];
    default: return ['1 = 1', []];
  }
}

router.get('/agendamentos', h((req, res) => {
  const [cond, params] = escopoAgendamentos(req.user);
  const w = [cond];
  const p = [...params];
  const q = req.query;
  if (q.data) { w.push('a.data = ?'); p.push(q.data); }
  if (q.de) { w.push('a.data >= ?'); p.push(q.de); }
  if (q.ate) { w.push('a.data <= ?'); p.push(q.ate); }
  if (q.status) { w.push('a.status = ?'); p.push(q.status); }
  if (q.pagamento) { w.push('a.status_pagamento = ?'); p.push(q.pagamento); }
  if (q.empresa_id) { w.push('a.empresa_id = ?'); p.push(Number(q.empresa_id)); }
  if (q.clinica_id) { w.push('a.clinica_id = ?'); p.push(Number(q.clinica_id)); }
  if (q.funcionario_id) { w.push('a.funcionario_id = ?'); p.push(Number(q.funcionario_id)); }
  if (q.q) {
    w.push('(f.nome LIKE ? OR f.cpf LIKE ? OR a.codigo LIKE ? OR e.razao_social LIKE ?)');
    const like = `%${q.q}%`;
    p.push(like, `%${digits(q.q) || q.q}%`, like, like);
  }
  const ordem = q.ordem === 'asc' ? 'a.data ASC, a.hora ASC' : 'a.data DESC, a.hora DESC';
  const limite = Math.min(Number(q.limite || 200), 1000);
  res.json(db.prepare(`${S.AG_SELECT} WHERE ${w.join(' AND ')} ORDER BY ${ordem} LIMIT ${limite}`).all(...p));
}));

router.post('/agendamentos', perfil('empresa', 'admin'), h(async (req, res) => {
  const id = S.criarAgendamento(req.user, req.body || {});
  const ag = await S.finalizarAgendamento(id);
  res.status(201).json(ag);
}));

function carregar(req) {
  const ag = S.buscarAgendamento(Number(req.params.id));
  S.checarAcessoAgendamento(req.user, ag);
  return ag;
}

router.get('/agendamentos/:id', h((req, res) => {
  const ag = carregar(req);
  res.json({
    ...ag,
    documentos: db.prepare('SELECT id, tipo, nome, mime, created_at FROM documentos WHERE agendamento_id = ? ORDER BY id').all(ag.id),
    resultados: db.prepare('SELECT * FROM resultados WHERE agendamento_id = ? ORDER BY id').all(ag.id),
    aso: ag.aso_id ? S.buscarASO(ag.aso_id) : null,
    notificacoes: db.prepare('SELECT canal, destino, assunto, status, created_at FROM notificacoes WHERE referencia = ? ORDER BY id DESC LIMIT 30').all(`agendamento:${ag.id}`),
  });
}));

router.get('/agendamentos/:id/guia', h(async (req, res) => {
  let ag = carregar(req);
  if (!ag.guia_path || !fs.existsSync(path.join(DATA_DIR, ag.guia_path))) {
    const { gerarGuia } = require('../pdf');
    const c = db.prepare('SELECT * FROM clinicas WHERE id = ?').get(ag.clinica_id);
    const arq = await gerarGuia(ag, { fin: S.dadosFinanceiros(c), maps: S.mapsUrl(c) });
    db.prepare('UPDATE agendamentos SET guia_path = ? WHERE id = ?').run(arq, ag.id);
    ag = S.buscarAgendamento(ag.id);
  }
  res.download(path.join(DATA_DIR, ag.guia_path), `Guia ${ag.codigo}.pdf`);
}));

router.post('/agendamentos/:id/reenviar', perfil('empresa', 'clinica', 'admin'), h(async (req, res) => {
  const ag = carregar(req);
  await notify.enviarGuia(ag, 'novo');
  res.json({ ok: true });
}));

router.post('/agendamentos/:id/reagendar', perfil('empresa', 'clinica', 'admin'), h(async (req, res) => {
  S.reagendar(req.user, Number(req.params.id), req.body || {});
  res.json(await S.finalizarAgendamento(Number(req.params.id), { evento: 'reagendado' }));
}));

router.post('/agendamentos/:id/cancelar', perfil('empresa', 'clinica', 'admin'), h((req, res) => {
  const ag = carregar(req);
  if (['realizado', 'cancelado'].includes(ag.status)) throw httpError(400, 'Este agendamento não pode ser cancelado');
  db.prepare("UPDATE agendamentos SET status = 'cancelado', observacoes_empresa = COALESCE(observacoes_empresa || ' | ', '') || ?, updated_at = ? WHERE id = ?")
    .run(`Cancelado por ${req.user.nome}${req.body && req.body.motivo ? `: ${req.body.motivo}` : ''}`, agoraISO(), ag.id);
  res.json(S.buscarAgendamento(ag.id));
}));

/** Envio do comprovante de pagamento (PIX). */
router.post('/agendamentos/:id/comprovante', perfil('empresa', 'clinica', 'admin'), upload.single('arquivo'), h((req, res) => {
  const ag = carregar(req);
  if (!req.file) throw httpError(400, 'Anexe o comprovante');
  if (ag.status_pagamento === 'pagamento_confirmado') throw httpError(400, 'Pagamento já confirmado');
  db.prepare("INSERT INTO documentos (agendamento_id, funcionario_id, tipo, nome, arquivo, mime, enviado_por) VALUES (?, ?, 'comprovante', ?, ?, ?, ?)")
    .run(ag.id, ag.funcionario_id, req.file.originalname, `uploads/${req.file.filename}`, req.file.mimetype, req.user.id);
  db.prepare("UPDATE agendamentos SET status_pagamento = 'comprovante_enviado', motivo_recusa = NULL, updated_at = ? WHERE id = ?").run(agoraISO(), ag.id);
  const atualizado = S.buscarAgendamento(ag.id);
  notify.enviarTodos([{ nome: atualizado.clinica_nome, email: atualizado.email_financeiro || atualizado.clinica_email, telefone: atualizado.whatsapp_financeiro }], {
    assunto: `Comprovante recebido — ${ag.codigo}`, texto: `Comprovante de pagamento enviado por ${req.user.nome}.\n\n${notify.resumoAgendamento(atualizado)}`,
    referencia: `agendamento:${ag.id}`,
  }).catch(() => {});
  res.json(atualizado);
}));

router.post('/agendamentos/:id/pagamento', perfil('clinica', 'admin'), h((req, res) => {
  const ag = carregar(req);
  const { acao, motivo } = req.body || {};
  if (!['confirmar', 'recusar'].includes(acao)) throw httpError(400, 'Ação inválida');
  if (acao === 'recusar' && !String(motivo || '').trim()) throw httpError(400, 'Informe o motivo da recusa');
  const status = acao === 'confirmar' ? 'pagamento_confirmado' : 'pagamento_recusado';
  db.prepare('UPDATE agendamentos SET status_pagamento = ?, motivo_recusa = ?, updated_at = ? WHERE id = ?')
    .run(status, acao === 'recusar' ? motivo : null, agoraISO(), ag.id);
  const atualizado = S.buscarAgendamento(ag.id);
  notify.enviarStatusPagamento(atualizado).catch(() => {});
  res.json(atualizado);
}));

/** Comparecimento / atendimento. O atendimento exige pagamento confirmado. */
router.post('/agendamentos/:id/status', perfil('clinica', 'medico', 'admin'), h((req, res) => {
  const ag = carregar(req);
  const { status } = req.body || {};
  const permitidos = { compareceu: ['agendado', 'ausente'], em_atendimento: ['compareceu', 'agendado'], ausente: ['agendado'] };
  if (!permitidos[status]) throw httpError(400, 'Status inválido');
  if (!permitidos[status].includes(ag.status)) throw httpError(400, `Não é possível mudar de "${ag.status}" para "${status}"`);
  if (ag.data > hoje()) throw httpError(400, 'Comparecimento e ausência só podem ser registrados a partir da data do exame');
  if (status !== 'ausente' && ag.status_pagamento !== 'pagamento_confirmado') {
    throw httpError(400, 'O funcionário somente será atendido após a confirmação do pagamento');
  }
  const medico = status === 'em_atendimento' && req.user.perfil === 'medico' ? req.user.medico_id : ag.medico_id;
  db.prepare('UPDATE agendamentos SET status = ?, medico_id = ?, updated_at = ? WHERE id = ?').run(status, medico, agoraISO(), ag.id);
  res.json(S.buscarAgendamento(ag.id));
}));

router.post('/agendamentos/:id/resultados', perfil('clinica', 'medico'), h((req, res) => {
  const ag = carregar(req);
  const { exame, resultado, observacao } = req.body || {};
  if (!String(exame || '').trim()) throw httpError(400, 'Informe o exame');
  if (ag.status === 'cancelado') throw httpError(400, 'Agendamento cancelado');
  db.prepare('INSERT INTO resultados (agendamento_id, exame, resultado, observacao) VALUES (?, ?, ?, ?)').run(ag.id, exame.trim(), resultado || null, observacao || null);
  res.status(201).json(db.prepare('SELECT * FROM resultados WHERE agendamento_id = ? ORDER BY id').all(ag.id));
}));

router.delete('/agendamentos/:id/resultados/:rid', perfil('clinica', 'medico'), h((req, res) => {
  const ag = carregar(req);
  if (ag.aso_id) throw httpError(400, 'ASO já emitido; resultados não podem ser removidos');
  db.prepare('DELETE FROM resultados WHERE id = ? AND agendamento_id = ?').run(Number(req.params.rid), ag.id);
  res.json({ ok: true });
}));

router.post('/agendamentos/:id/laudo', perfil('clinica', 'medico'), upload.single('arquivo'), h((req, res) => {
  const ag = carregar(req);
  if (!req.file) throw httpError(400, 'Anexe o laudo');
  db.prepare("INSERT INTO documentos (agendamento_id, funcionario_id, tipo, nome, arquivo, mime, enviado_por) VALUES (?, ?, 'laudo', ?, ?, ?, ?)")
    .run(ag.id, ag.funcionario_id, req.body.nome || req.file.originalname, `uploads/${req.file.filename}`, req.file.mimetype, req.user.id);
  res.status(201).json({ ok: true });
}));

router.post('/agendamentos/:id/observacoes', perfil('medico', 'clinica'), h((req, res) => {
  const ag = carregar(req);
  db.prepare('UPDATE agendamentos SET observacoes_medico = ?, updated_at = ? WHERE id = ?').run(String(req.body.observacoes || ''), agoraISO(), ag.id);
  res.json(S.buscarAgendamento(ag.id));
}));

router.post('/agendamentos/:id/aso', perfil('clinica', 'medico'), h(async (req, res) => {
  res.status(201).json(await S.emitirASO(req.user, Number(req.params.id), req.body || {}));
}));

/* ------------------------------------------------------------------ */
/* ASOs e documentos                                                    */
/* ------------------------------------------------------------------ */

router.get('/asos', h((req, res) => {
  const u = req.user;
  const w = [];
  const p = [];
  if (u.perfil === 'empresa') { w.push('s.empresa_id = ?'); p.push(u.empresa_id); }
  if (u.perfil === 'clinica') { w.push('ag.clinica_id = ?'); p.push(u.clinica_id); }
  if (u.perfil === 'medico') { w.push('ag.clinica_id = ?'); p.push(S.clinicaDoMedico(u.medico_id)); }
  if (req.query.pendente_assinatura) w.push('s.hash_assinatura IS NULL');
  if (req.query.funcionario_id) { w.push('s.funcionario_id = ?'); p.push(Number(req.query.funcionario_id)); }
  const rows = db.prepare(
    `SELECT s.id, s.agendamento_id, s.data_emissao, s.data_validade, s.conclusao, s.hash_assinatura, s.assinado_em, s.funcao,
       f.nome AS func_nome, f.cpf AS func_cpf, e.razao_social, t.nome AS tipo_nome, m.nome AS medico_nome, ag.codigo
     FROM asos s JOIN funcionarios f ON f.id = s.funcionario_id JOIN empresas e ON e.id = s.empresa_id
     JOIN tipos_exame t ON t.id = s.tipo_exame_id JOIN agendamentos ag ON ag.id = s.agendamento_id
     LEFT JOIN medicos m ON m.id = s.medico_id
     ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY s.data_emissao DESC, s.id DESC LIMIT 500`,
  ).all(...p);
  res.json(rows);
}));

router.post('/asos/:id/assinar', perfil('medico'), h(async (req, res) => {
  res.json(await S.assinarASO(req.user, Number(req.params.id)));
}));

router.get('/asos/:id/pdf', h(async (req, res) => {
  const aso = S.buscarASO(Number(req.params.id));
  S.checarAcessoAgendamento(req.user, S.buscarAgendamento(aso.agendamento_id));
  if (!aso.arquivo || !fs.existsSync(path.join(DATA_DIR, aso.arquivo))) await S.gerarArquivoASO(aso.id);
  const atual = S.buscarASO(aso.id);
  res.download(path.join(DATA_DIR, atual.arquivo), `ASO ${atual.func_nome}.pdf`);
}));

router.get('/documentos/:id', h((req, res) => {
  const d = db.prepare('SELECT * FROM documentos WHERE id = ?').get(Number(req.params.id));
  if (!d) throw httpError(404, 'Documento não encontrado');
  S.checarAcessoAgendamento(req.user, S.buscarAgendamento(d.agendamento_id));
  const arquivo = path.join(DATA_DIR, d.arquivo);
  if (!arquivo.startsWith(DATA_DIR) || !fs.existsSync(arquivo)) throw httpError(404, 'Arquivo não encontrado');
  res.download(arquivo, d.nome);
}));

/* ------------------------------------------------------------------ */
/* Funcionários e histórico (PCMSO)                                      */
/* ------------------------------------------------------------------ */

function checarFuncionario(user, f) {
  if (!f) throw httpError(404, 'Funcionário não encontrado');
  if (user.perfil === 'empresa' && f.empresa_id !== user.empresa_id) throw httpError(403, 'Sem acesso');
  if (['clinica', 'medico'].includes(user.perfil)) {
    const clinica = user.clinica_id || S.clinicaDoMedico(user.medico_id);
    const ok = db.prepare('SELECT 1 FROM agendamentos WHERE funcionario_id = ? AND clinica_id = ? LIMIT 1').get(f.id, clinica);
    if (!ok) throw httpError(403, 'Sem acesso');
  }
}

router.get('/funcionarios', perfil('empresa', 'admin'), h((req, res) => {
  const empresaId = req.user.perfil === 'empresa' ? req.user.empresa_id : req.query.empresa_id ? Number(req.query.empresa_id) : null;
  const venc = Object.fromEntries(S.vencimentos({ empresaId }).map((v) => [v.funcionario_id, v]));
  const w = [];
  const p = [];
  if (empresaId) { w.push('f.empresa_id = ?'); p.push(empresaId); }
  if (req.query.q) { w.push('(f.nome LIKE ? OR f.cpf LIKE ?)'); p.push(`%${req.query.q}%`, `%${digits(req.query.q) || req.query.q}%`); }
  const rows = db.prepare(
    `SELECT f.*, e.razao_social FROM funcionarios f JOIN empresas e ON e.id = f.empresa_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY f.nome`,
  ).all(...p);
  res.json(rows.map((f) => ({ ...f, vencimento: venc[f.id] || null })));
}));

router.get('/funcionarios/:id', h((req, res) => {
  const f = db.prepare('SELECT f.*, e.razao_social, e.cnpj FROM funcionarios f JOIN empresas e ON e.id = f.empresa_id WHERE f.id = ?').get(Number(req.params.id));
  checarFuncionario(req.user, f);
  res.json({
    ...f,
    historico: db.prepare('SELECT * FROM historico_funcional WHERE funcionario_id = ? ORDER BY data DESC, id DESC').all(f.id),
    asos: db.prepare(
      `SELECT s.id, s.data_emissao, s.data_validade, s.conclusao, s.hash_assinatura, s.funcao, t.nome AS tipo_nome, m.nome AS medico_nome
       FROM asos s JOIN tipos_exame t ON t.id = s.tipo_exame_id LEFT JOIN medicos m ON m.id = s.medico_id WHERE s.funcionario_id = ? ORDER BY s.data_emissao DESC`,
    ).all(f.id),
    agendamentos: db.prepare(`${S.AG_SELECT} WHERE a.funcionario_id = ? ORDER BY a.data DESC, a.hora DESC`).all(f.id),
    vencimento: S.vencimentos({ empresaId: f.empresa_id }).find((v) => v.funcionario_id === f.id) || null,
  });
}));

router.put('/funcionarios/:id', perfil('empresa', 'admin'), h((req, res) => {
  const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(Number(req.params.id));
  checarFuncionario(req.user, f);
  const b = req.body || {};
  const situacao = b.situacao || f.situacao;
  if (!['ativo', 'afastado', 'demitido'].includes(situacao)) throw httpError(400, 'Situação inválida');
  db.prepare('UPDATE funcionarios SET nome = ?, rg = ?, telefone = ?, email = ?, data_nascimento = ?, situacao = ? WHERE id = ?').run(
    b.nome || f.nome, b.rg || f.rg, b.telefone || f.telefone, b.email ?? f.email, b.data_nascimento || f.data_nascimento, situacao, f.id,
  );
  res.json(db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(f.id));
}));

router.get('/vencimentos', perfil('empresa', 'admin'), h((req, res) => {
  const empresaId = req.user.perfil === 'empresa' ? req.user.empresa_id : req.query.empresa_id ? Number(req.query.empresa_id) : undefined;
  res.json(S.vencimentos({ empresaId }));
}));

/* ------------------------------------------------------------------ */
/* Dashboards por perfil                                                */
/* ------------------------------------------------------------------ */

const contar = (sql, ...p) => db.prepare(sql).get(...p).n;

router.get('/dashboard', h((req, res) => {
  const u = req.user;
  const h0 = hoje();
  if (u.perfil === 'admin') return res.json(require('./admin').dashboardAdmin());

  if (u.perfil === 'empresa') {
    const venc = S.vencimentos({ empresaId: u.empresa_id });
    return res.json({
      exames_solicitados: contar('SELECT COUNT(*) n FROM agendamentos WHERE empresa_id = ?', u.empresa_id),
      exames_pendentes: contar("SELECT COUNT(*) n FROM agendamentos WHERE empresa_id = ? AND status IN ('agendado','compareceu','em_atendimento')", u.empresa_id),
      asos_disponiveis: contar('SELECT COUNT(*) n FROM asos WHERE empresa_id = ?', u.empresa_id),
      pagamentos_pendentes: contar("SELECT COUNT(*) n FROM agendamentos WHERE empresa_id = ? AND status = 'agendado' AND status_pagamento != 'pagamento_confirmado'", u.empresa_id),
      vencimentos_proximos: venc.filter((v) => v.situacao === 'a_vencer'),
      funcionarios_em_atraso: venc.filter((v) => v.situacao === 'vencido' || v.situacao === 'sem_aso'),
      proximos_exames: db.prepare(`${S.AG_SELECT} WHERE a.empresa_id = ? AND a.data >= ? AND a.status = 'agendado' ORDER BY a.data, a.hora LIMIT 10`).all(u.empresa_id, h0),
    });
  }

  const clinica = u.clinica_id || S.clinicaDoMedico(u.medico_id);
  const base = {
    atendimentos_do_dia: db.prepare(`${S.AG_SELECT} WHERE a.clinica_id = ? AND a.data = ? AND a.status != 'cancelado' ORDER BY a.hora`).all(clinica, h0),
    proximos_atendimentos: db.prepare(`${S.AG_SELECT} WHERE a.clinica_id = ? AND a.data > ? AND a.data <= ? AND a.status = 'agendado' ORDER BY a.data, a.hora LIMIT 30`).all(clinica, h0, addDias(h0, 7)),
    pagamentos_pendentes: db.prepare(`${S.AG_SELECT} WHERE a.clinica_id = ? AND a.status IN ('agendado','compareceu') AND a.status_pagamento != 'pagamento_confirmado' ORDER BY a.status_pagamento = 'comprovante_enviado' DESC, a.data LIMIT 50`).all(clinica),
    exames_concluidos_hoje: contar("SELECT COUNT(*) n FROM agendamentos WHERE clinica_id = ? AND data = ? AND status = 'realizado'", clinica, h0),
    exames_concluidos_mes: contar("SELECT COUNT(*) n FROM agendamentos WHERE clinica_id = ? AND substr(data,1,7) = ? AND status = 'realizado'", clinica, h0.slice(0, 7)),
    pacientes_ausentes: db.prepare(`${S.AG_SELECT} WHERE a.clinica_id = ? AND a.status = 'ausente' AND a.data >= ? ORDER BY a.data DESC LIMIT 30`).all(clinica, addDias(h0, -30)),
  };
  if (u.perfil === 'medico') {
    base.asos_pendentes_assinatura = contar(
      'SELECT COUNT(*) n FROM asos s JOIN agendamentos a ON a.id = s.agendamento_id WHERE a.clinica_id = ? AND s.hash_assinatura IS NULL AND (s.medico_id = ? OR s.medico_id IS NULL)',
      clinica, u.medico_id,
    );
  }
  res.json(base);
}));

module.exports = router;
