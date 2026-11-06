'use strict';
const express = require('express');
const { db, getConfig, setConfig } = require('../db');
const { autenticar, perfil, hashSenha } = require('../auth');
const { h, httpError, digits, validaCNPJ, validaDocumento, hoje, addDias, pick, exigir } = require('../util');

const router = express.Router();
router.use(autenticar, perfil('admin'));

/* ------------------------------------------------------------------ */
/* CRUD genérico                                                        */
/* ------------------------------------------------------------------ */

function crud(rota, tabela, campos, { obrigatorios = [], normalizar = (d) => d, ordem = 'id DESC', listar, depoisCriar } = {}) {
  router.get(`/${rota}`, h((req, res) => res.json(db.prepare(listar || `SELECT * FROM ${tabela} ORDER BY ${ordem}`).all())));

  router.post(`/${rota}`, h((req, res) => {
    const dados = normalizar(pick(req.body || {}, campos), true);
    exigir(dados, obrigatorios);
    const cols = Object.keys(dados);
    const r = db.prepare(`INSERT INTO ${tabela} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => dados[c]));
    if (depoisCriar) depoisCriar(Number(r.lastInsertRowid));
    res.status(201).json(db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(r.lastInsertRowid));
  }));

  router.put(`/${rota}/:id`, h((req, res) => {
    const atual = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(Number(req.params.id));
    if (!atual) throw httpError(404, 'Registro não encontrado');
    const dados = normalizar(pick(req.body || {}, campos), false);
    const cols = Object.keys(dados);
    if (cols.length) {
      db.prepare(`UPDATE ${tabela} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => dados[c]), atual.id);
    }
    res.json(db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(atual.id));
  }));
}

crud('empresas', 'empresas', ['cnpj', 'razao_social', 'responsavel', 'telefone', 'email', 'ativo'], {
  obrigatorios: ['cnpj', 'razao_social', 'responsavel', 'telefone', 'email'],
  listar: `SELECT e.*, u.login AS acesso_login, u.trocar_senha AS acesso_pendente, u.ativo AS acesso_ativo
           FROM empresas e LEFT JOIN usuarios u ON u.empresa_id = e.id AND u.perfil = 'empresa' AND u.login IS NOT NULL
           ORDER BY e.razao_social`,
  normalizar: (d) => {
    if (d.cnpj !== undefined) {
      d.cnpj = digits(d.cnpj);
      if (!validaDocumento(d.cnpj)) throw httpError(400, 'CNPJ ou CPF inválido');
    }
    return d;
  },
  depoisCriar: (id) => require('../services').garantirAcessoEmpresa(id),
});

/* Sincronização com o eSocial Brasil: situação e execução manual */
router.get('/esocial/sincronizacao', h((req, res) => {
  const r = getConfig('esocial_sync_resultado', '');
  res.json({ configurado: require('../esocial').configurado(), hora: process.env.ESOCIAL_SYNC_HORA || '00:00', ultima: r ? JSON.parse(r) : null });
}));
router.post('/esocial/sincronizar', h(async (req, res) => {
  const r = await require('../scheduler').sincronizacaoDiaria({ forcar: true });
  if (!r) throw httpError(409, 'Já existe uma sincronização em andamento');
  if (r.pulado || r.erro) throw httpError(400, r.pulado || r.erro);
  res.json(r);
}));

/* Acesso da empresa: volta para a senha inicial, com troca obrigatória */
router.post('/empresas/:id/acesso/redefinir', h((req, res) => {
  const S = require('../services');
  const u = S.garantirAcessoEmpresa(Number(req.params.id));
  if (!u) throw httpError(404, 'Empresa não encontrada');
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, ativo = 1 WHERE id = ?').run(hashSenha(S.SENHA_INICIAL()), u.id);
  res.json({ ok: true, login: u.login });
}));

crud('clinicas', 'clinicas', [
  'nome', 'cnpj', 'endereco', 'bairro', 'cidade', 'uf', 'cep', 'telefone', 'email', 'whatsapp_financeiro', 'email_financeiro', 'maps_url',
  'pix_chave', 'pix_nome', 'pix_cidade', 'hora_inicio', 'hora_fim', 'intervalo_min', 'capacidade_horario', 'dias_semana', 'ativo',
], {
  obrigatorios: ['nome', 'endereco', 'cidade', 'uf', 'telefone'],
  ordem: 'nome',
  normalizar: (d) => {
    for (const k of ['hora_inicio', 'hora_fim']) if (d[k] !== undefined && !/^\d{2}:\d{2}$/.test(d[k])) throw httpError(400, 'Horário deve estar no formato HH:MM');
    if (d.intervalo_min !== undefined) d.intervalo_min = Math.max(5, Number(d.intervalo_min) || 20);
    if (d.capacidade_horario !== undefined) d.capacidade_horario = Math.max(1, Number(d.capacidade_horario) || 1);
    if (d.cnpj) d.cnpj = digits(d.cnpj);
    return d;
  },
});

crud('medicos', 'medicos', ['nome', 'crm', 'uf_crm', 'clinica_id', 'email', 'telefone', 'ativo'], {
  obrigatorios: ['nome', 'crm', 'uf_crm', 'clinica_id'], ordem: 'nome',
});

crud('tipos-exame', 'tipos_exame', ['codigo', 'nome', 'categoria', 'descricao', 'valor_padrao', 'validade_meses', 'ativo'], {
  obrigatorios: ['codigo', 'nome'], ordem: "categoria DESC, id",
  normalizar: (d) => {
    if (d.valor_padrao !== undefined) d.valor_padrao = Number(d.valor_padrao) || 0;
    if (d.validade_meses !== undefined) d.validade_meses = d.validade_meses === '' || d.validade_meses == null ? null : Number(d.validade_meses);
    return d;
  },
});

/* Riscos ocupacionais por função (PGR) de cada empresa */
const svc = () => require('../services');
const empresaOu404 = (id) => {
  const e = db.prepare('SELECT id, razao_social, cnpj, esocial_id FROM empresas WHERE id = ?').get(Number(id));
  if (!e) throw httpError(404, 'Empresa não encontrada');
  return e;
};
router.get('/empresas/:id/riscos', h((req, res) => {
  const e = empresaOu404(req.params.id);
  res.json({
    empresa: e,
    esocial: require('../esocial').configurado(),
    funcoes: db.prepare('SELECT * FROM riscos_funcao WHERE empresa_id = ? ORDER BY funcao').all(e.id),
  });
}));
router.post('/empresas/:id/riscos', h((req, res) => {
  const e = empresaOu404(req.params.id);
  res.status(201).json(svc().salvarRiscoFuncao(e.id, req.body || {}));
}));
router.delete('/empresas/:id/riscos/:rid', h((req, res) => {
  const e = empresaOu404(req.params.id);
  db.prepare('DELETE FROM riscos_funcao WHERE id = ? AND empresa_id = ?').run(Number(req.params.rid), e.id);
  res.json({ ok: true });
}));
router.post('/empresas/:id/riscos/importar-esocial', h(async (req, res) => {
  const e = empresaOu404(req.params.id);
  res.json(await svc().importarFuncoesEsocial(e.id));
}));

/* Usuários (senha tratada à parte) */
router.get('/usuarios', h((req, res) => {
  res.json(db.prepare(
    `SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id, u.clinica_id, u.medico_id, u.ativo, u.created_at,
       e.razao_social, c.nome AS clinica_nome, m.nome AS medico_nome
     FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id LEFT JOIN clinicas c ON c.id = u.clinica_id LEFT JOIN medicos m ON m.id = u.medico_id
     ORDER BY u.perfil, u.nome`,
  ).all());
}));

function validarVinculo(d) {
  if (d.perfil === 'empresa' && !d.empresa_id) throw httpError(400, 'Usuário de empresa precisa de uma empresa vinculada');
  if (d.perfil === 'clinica' && !d.clinica_id) throw httpError(400, 'Usuário de clínica precisa de uma clínica vinculada');
  if (d.perfil === 'medico') {
    if (!d.medico_id) throw httpError(400, 'Usuário médico precisa de um médico vinculado');
    d.clinica_id = (db.prepare('SELECT clinica_id FROM medicos WHERE id = ?').get(Number(d.medico_id)) || {}).clinica_id || null;
  }
  for (const k of ['empresa_id', 'clinica_id', 'medico_id']) d[k] = d[k] ? Number(d[k]) : null;
}

router.post('/usuarios', h((req, res) => {
  const d = pick(req.body || {}, ['nome', 'email', 'senha', 'perfil', 'empresa_id', 'clinica_id', 'medico_id']);
  exigir(d, ['nome', 'email', 'senha', 'perfil']);
  if (!['admin', 'clinica', 'empresa', 'medico'].includes(d.perfil)) throw httpError(400, 'Perfil inválido');
  if (String(d.senha).length < 6) throw httpError(400, 'Senha deve ter ao menos 6 caracteres');
  validarVinculo(d);
  try {
    const r = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, clinica_id, medico_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.nome.trim(), d.email.trim().toLowerCase(), hashSenha(d.senha), d.perfil, d.empresa_id, d.clinica_id, d.medico_id);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw httpError(409, 'Já existe um usuário com este e-mail');
    throw e;
  }
}));

router.put('/usuarios/:id', h((req, res) => {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(req.params.id));
  if (!u) throw httpError(404, 'Usuário não encontrado');
  const d = { ...u, ...pick(req.body || {}, ['nome', 'email', 'perfil', 'empresa_id', 'clinica_id', 'medico_id', 'ativo']) };
  validarVinculo(d);
  if (u.id === req.user.id && (Number(d.ativo) === 0 || d.perfil !== 'admin')) throw httpError(400, 'Você não pode desativar ou rebaixar o próprio usuário');
  db.prepare('UPDATE usuarios SET nome = ?, email = ?, perfil = ?, empresa_id = ?, clinica_id = ?, medico_id = ?, ativo = ? WHERE id = ?')
    .run(d.nome, String(d.email).toLowerCase(), d.perfil, d.empresa_id, d.clinica_id, d.medico_id, Number(d.ativo) ? 1 : 0, u.id);
  if (req.body && req.body.senha) {
    if (String(req.body.senha).length < 6) throw httpError(400, 'Senha deve ter ao menos 6 caracteres');
    db.prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?').run(hashSenha(req.body.senha), u.id);
  }
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Valores por clínica                                                  */
/* ------------------------------------------------------------------ */

router.get('/precos', h((req, res) => {
  res.json(db.prepare(
    `SELECT c.id AS clinica_id, c.nome AS clinica_nome, t.id AS tipo_exame_id, t.nome AS tipo_nome, t.categoria, t.valor_padrao, p.valor
     FROM clinicas c CROSS JOIN tipos_exame t LEFT JOIN precos p ON p.clinica_id = c.id AND p.tipo_exame_id = t.id
     WHERE c.ativo = 1 AND t.ativo = 1 ORDER BY c.nome, t.categoria DESC, t.id`,
  ).all());
}));

router.put('/precos', h((req, res) => {
  const { clinica_id, tipo_exame_id, valor } = req.body || {};
  if (!clinica_id || !tipo_exame_id) throw httpError(400, 'Informe clínica e tipo de exame');
  if (valor === '' || valor == null) {
    db.prepare('DELETE FROM precos WHERE clinica_id = ? AND tipo_exame_id = ?').run(Number(clinica_id), Number(tipo_exame_id));
  } else {
    db.prepare('INSERT INTO precos (clinica_id, tipo_exame_id, valor) VALUES (?, ?, ?) ON CONFLICT(clinica_id, tipo_exame_id) DO UPDATE SET valor = excluded.valor')
      .run(Number(clinica_id), Number(tipo_exame_id), Number(valor));
  }
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/* Configuração PIX / contatos financeiros                              */
/* ------------------------------------------------------------------ */

const CHAVES_CONFIG = ['pix_chave', 'pix_nome', 'pix_cidade', 'whatsapp_financeiro', 'email_financeiro'];
router.get('/config', h((req, res) => res.json(Object.fromEntries(CHAVES_CONFIG.map((k) => [k, getConfig(k, '')])))));
router.put('/config', h((req, res) => {
  for (const k of CHAVES_CONFIG) if (req.body && req.body[k] !== undefined) setConfig(k, String(req.body[k]).trim());
  res.json(Object.fromEntries(CHAVES_CONFIG.map((k) => [k, getConfig(k, '')])));
}));

/* ------------------------------------------------------------------ */
/* Faturamento e relatórios                                             */
/* ------------------------------------------------------------------ */

router.get('/faturamento', h((req, res) => {
  const de = req.query.de || `${hoje().slice(0, 7)}-01`;
  const ate = req.query.ate || hoje();
  const filtro = 'a.data BETWEEN ? AND ?';
  res.json({
    de, ate,
    total_confirmado: db.prepare(`SELECT COALESCE(SUM(valor),0) v FROM agendamentos a WHERE ${filtro} AND status_pagamento = 'pagamento_confirmado'`).get(de, ate).v,
    total_pendente: db.prepare(`SELECT COALESCE(SUM(valor),0) v FROM agendamentos a WHERE ${filtro} AND status != 'cancelado' AND status_pagamento != 'pagamento_confirmado'`).get(de, ate).v,
    por_clinica: db.prepare(
      `SELECT c.nome, COUNT(*) exames, SUM(CASE WHEN a.status_pagamento = 'pagamento_confirmado' THEN a.valor ELSE 0 END) confirmado,
         SUM(CASE WHEN a.status != 'cancelado' AND a.status_pagamento != 'pagamento_confirmado' THEN a.valor ELSE 0 END) pendente
       FROM agendamentos a JOIN clinicas c ON c.id = a.clinica_id WHERE ${filtro} GROUP BY c.id ORDER BY confirmado DESC`,
    ).all(de, ate),
    por_empresa: db.prepare(
      `SELECT e.razao_social AS nome, COUNT(*) exames, SUM(CASE WHEN a.status_pagamento = 'pagamento_confirmado' THEN a.valor ELSE 0 END) confirmado,
         SUM(CASE WHEN a.status != 'cancelado' AND a.status_pagamento != 'pagamento_confirmado' THEN a.valor ELSE 0 END) pendente
       FROM agendamentos a JOIN empresas e ON e.id = a.empresa_id WHERE ${filtro} GROUP BY e.id ORDER BY confirmado DESC`,
    ).all(de, ate),
    por_tipo: db.prepare(
      `SELECT t.nome, COUNT(*) exames, SUM(CASE WHEN a.status_pagamento = 'pagamento_confirmado' THEN a.valor ELSE 0 END) confirmado
       FROM agendamentos a JOIN tipos_exame t ON t.id = a.tipo_exame_id WHERE ${filtro} GROUP BY t.id ORDER BY exames DESC`,
    ).all(de, ate),
  });
}));

const csv = (rows) => {
  if (!rows.length) return '﻿';
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return `﻿${cols.join(';')}\n${rows.map((r) => cols.map((c) => esc(r[c])).join(';')).join('\n')}`;
};

const RELATORIOS = {
  agendamentos: (de, ate) => db.prepare(
    `SELECT a.codigo, a.data, a.hora, t.nome AS tipo, e.razao_social AS empresa, e.cnpj, f.nome AS funcionario, f.cpf, f.funcao,
       c.nome AS clinica, a.valor, a.status, a.status_pagamento
     FROM agendamentos a JOIN empresas e ON e.id = a.empresa_id JOIN funcionarios f ON f.id = a.funcionario_id
     JOIN clinicas c ON c.id = a.clinica_id JOIN tipos_exame t ON t.id = a.tipo_exame_id
     WHERE a.data BETWEEN ? AND ? ORDER BY a.data, a.hora`,
  ).all(de, ate),
  asos: (de, ate) => db.prepare(
    `SELECT s.id, s.data_emissao, s.data_validade, t.nome AS tipo, e.razao_social AS empresa, f.nome AS funcionario, f.cpf, s.funcao,
       s.conclusao, m.nome AS medico, m.crm, CASE WHEN s.hash_assinatura IS NULL THEN 'não' ELSE 'sim' END AS assinado
     FROM asos s JOIN empresas e ON e.id = s.empresa_id JOIN funcionarios f ON f.id = s.funcionario_id
     JOIN tipos_exame t ON t.id = s.tipo_exame_id LEFT JOIN medicos m ON m.id = s.medico_id
     WHERE s.data_emissao BETWEEN ? AND ? ORDER BY s.data_emissao`,
  ).all(de, ate),
  vencimentos: () => require('../services').vencimentos().map((v) => ({
    empresa: v.razao_social, funcionario: v.nome, cpf: v.cpf, funcao: v.funcao, ultimo_aso: v.tipo_nome, emissao: v.data_emissao,
    validade: v.data_validade, dias_para_vencer: v.dias_para_vencer, situacao: v.situacao, proximo_agendamento: v.proximo_agendamento,
  })),
};

router.get('/relatorios/:tipo', h((req, res) => {
  const fn = RELATORIOS[req.params.tipo];
  if (!fn) throw httpError(404, 'Relatório inexistente');
  const de = req.query.de || addDias(hoje(), -30);
  const ate = req.query.ate || addDias(hoje(), 365);
  const rows = fn(de, ate);
  if (req.query.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="relatorio-${req.params.tipo}-${hoje()}.csv"`);
    return res.send(csv(rows));
  }
  res.json(rows);
}));

router.get('/notificacoes', h((req, res) => {
  res.json(db.prepare('SELECT * FROM notificacoes ORDER BY id DESC LIMIT ?').all(Math.min(Number(req.query.limite || 200), 1000)));
}));

router.post('/alertas/executar', h(async (req, res) => {
  res.json(await require('../scheduler').rodar());
}));

/* ------------------------------------------------------------------ */
/* Dashboard administrativo                                             */
/* ------------------------------------------------------------------ */

function dashboardAdmin() {
  const h0 = hoje();
  const um = (sql, ...p) => db.prepare(sql).get(...p);
  const receita = (cond, ...p) => um(`SELECT COALESCE(SUM(valor),0) v FROM agendamentos WHERE status_pagamento = 'pagamento_confirmado' AND ${cond}`, ...p).v;
  const meses = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const porMes = Object.fromEntries(
    db.prepare(
      `SELECT substr(data,1,7) mes, COUNT(*) agendamentos,
         SUM(CASE WHEN status_pagamento = 'pagamento_confirmado' THEN valor ELSE 0 END) receita,
         SUM(CASE WHEN status = 'realizado' THEN 1 ELSE 0 END) realizados,
         SUM(CASE WHEN status = 'ausente' THEN 1 ELSE 0 END) ausentes,
         SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END) cancelados
       FROM agendamentos WHERE data >= ? GROUP BY mes`,
    ).all(`${meses[0]}-01`).map((r) => [r.mes, r]),
  );
  const dias = [];
  for (let i = 29; i >= 0; i--) dias.push(addDias(h0, -i));
  const porDia = Object.fromEntries(
    db.prepare("SELECT data, COUNT(*) n FROM agendamentos WHERE data >= ? AND status != 'cancelado' GROUP BY data").all(dias[0]).map((r) => [r.data, r.n]),
  );
  return {
    indicadores: {
      agendados_hoje: um("SELECT COUNT(*) n FROM agendamentos WHERE data = ? AND status != 'cancelado'", h0).n,
      realizados_hoje: um("SELECT COUNT(*) n FROM agendamentos WHERE data = ? AND status = 'realizado'", h0).n,
      pendentes: um("SELECT COUNT(*) n FROM agendamentos WHERE status IN ('agendado','compareceu','em_atendimento') AND data >= ?", h0).n,
      cancelamentos_mes: um("SELECT COUNT(*) n FROM agendamentos WHERE status = 'cancelado' AND substr(data,1,7) = ?", h0.slice(0, 7)).n,
      receita_dia: receita('data = ?', h0),
      receita_mes: receita('substr(data,1,7) = ?', h0.slice(0, 7)),
      receita_ano: receita('substr(data,1,4) = ?', h0.slice(0, 4)),
      pagamentos_a_conferir: um("SELECT COUNT(*) n FROM agendamentos WHERE status_pagamento = 'comprovante_enviado'").n,
    },
    graficos: {
      agendamentos_por_dia: dias.map((d) => ({ rotulo: d, valor: porDia[d] || 0 })),
      faturamento_mensal: meses.map((m) => ({ rotulo: m, valor: (porMes[m] && porMes[m].receita) || 0 })),
      comparecimento_mensal: meses.map((m) => ({
        rotulo: m,
        realizados: (porMes[m] && porMes[m].realizados) || 0,
        ausentes: (porMes[m] && porMes[m].ausentes) || 0,
        cancelados: (porMes[m] && porMes[m].cancelados) || 0,
      })),
      exames_por_empresa: db.prepare(
        `SELECT e.razao_social AS rotulo, COUNT(*) valor FROM agendamentos a JOIN empresas e ON e.id = a.empresa_id
         WHERE a.status != 'cancelado' AND a.data >= ? GROUP BY e.id ORDER BY valor DESC LIMIT 10`,
      ).all(`${meses[0]}-01`),
    },
  };
}

module.exports = router;
module.exports.dashboardAdmin = dashboardAdmin;
