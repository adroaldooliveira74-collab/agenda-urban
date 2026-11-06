'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { db, tx, getConfig } = require('./db');
const {
  httpError, digits, validaCPF, validaCNPJ, hoje, agoraISO, addMeses, diasEntre, dataHora, isISODate,
  gerarCodigo, exigir, fmtData,
} = require('./util');
const { gerarPayloadPix } = require('./pix');

/* ------------------------------------------------------------------ */
/* Consultas base                                                       */
/* ------------------------------------------------------------------ */

const AG_SELECT = `
SELECT a.*,
  e.razao_social, e.cnpj, e.responsavel, e.telefone AS empresa_telefone, e.email AS empresa_email,
  f.nome AS func_nome, f.cpf AS func_cpf, f.rg AS func_rg, f.data_nascimento AS func_nascimento,
  f.funcao AS func_funcao, f.telefone AS func_telefone, f.email AS func_email, f.situacao AS func_situacao,
  c.nome AS clinica_nome, c.endereco AS clinica_endereco, c.bairro AS clinica_bairro, c.cidade AS clinica_cidade,
  c.uf AS clinica_uf, c.cep AS clinica_cep, c.telefone AS clinica_telefone, c.email AS clinica_email,
  c.whatsapp_financeiro, c.email_financeiro, c.maps_url,
  t.nome AS tipo_nome, t.codigo AS tipo_codigo,
  m.nome AS medico_nome, m.crm AS medico_crm, m.uf_crm AS medico_uf_crm,
  (SELECT id FROM asos WHERE agendamento_id = a.id) AS aso_id
FROM agendamentos a
JOIN empresas e ON e.id = a.empresa_id
JOIN funcionarios f ON f.id = a.funcionario_id
JOIN clinicas c ON c.id = a.clinica_id
JOIN tipos_exame t ON t.id = a.tipo_exame_id
LEFT JOIN medicos m ON m.id = a.medico_id`;

function buscarAgendamento(id) {
  const ag = db.prepare(`${AG_SELECT} WHERE a.id = ?`).get(id);
  if (!ag) throw httpError(404, 'Agendamento não encontrado');
  return ag;
}

/** Verifica se o usuário pode ver/alterar o agendamento. */
function checarAcessoAgendamento(user, ag) {
  const ok =
    user.perfil === 'admin' ||
    (user.perfil === 'empresa' && ag.empresa_id === user.empresa_id) ||
    (user.perfil === 'clinica' && ag.clinica_id === user.clinica_id) ||
    (user.perfil === 'medico' && (ag.medico_id === user.medico_id || ag.clinica_id === clinicaDoMedico(user.medico_id)));
  if (!ok) throw httpError(403, 'Sem acesso a este agendamento');
}

function clinicaDoMedico(medicoId) {
  const m = db.prepare('SELECT clinica_id FROM medicos WHERE id = ?').get(medicoId);
  return m ? m.clinica_id : null;
}

function tipoPorCodigoOuId(v) {
  const t = /^\d+$/.test(String(v))
    ? db.prepare('SELECT * FROM tipos_exame WHERE id = ? AND ativo = 1').get(Number(v))
    : db.prepare('SELECT * FROM tipos_exame WHERE codigo = ? AND ativo = 1').get(String(v));
  if (!t) throw httpError(400, 'Tipo de exame inválido');
  return t;
}

function precoExame(clinicaId, tipoId) {
  const p = db.prepare('SELECT valor FROM precos WHERE clinica_id = ? AND tipo_exame_id = ?').get(clinicaId, tipoId);
  if (p) return p.valor;
  const t = db.prepare('SELECT valor_padrao FROM tipos_exame WHERE id = ?').get(tipoId);
  return t ? t.valor_padrao : 0;
}

/** Dados de PIX e contato financeiro: os da clínica, ou os globais configurados pelo admin. */
function dadosFinanceiros(clinica) {
  return {
    pix_chave: clinica.pix_chave || getConfig('pix_chave'),
    pix_nome: clinica.pix_nome || getConfig('pix_nome') || clinica.nome,
    pix_cidade: clinica.pix_cidade || getConfig('pix_cidade') || clinica.cidade,
    whatsapp: clinica.whatsapp_financeiro || getConfig('whatsapp_financeiro') || clinica.telefone,
    email: clinica.email_financeiro || getConfig('email_financeiro') || clinica.email || '',
  };
}

function mapsUrl(c) {
  if (c.maps_url) return c.maps_url;
  const q = [c.endereco, c.bairro, c.cidade, c.uf, c.cep].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/* ------------------------------------------------------------------ */
/* Disponibilidade                                                      */
/* ------------------------------------------------------------------ */

function horariosDoDia(clinica) {
  const [hi, mi] = clinica.hora_inicio.split(':').map(Number);
  const [hf, mf] = clinica.hora_fim.split(':').map(Number);
  const out = [];
  for (let t = hi * 60 + mi; t < hf * 60 + mf; t += clinica.intervalo_min) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

function horariosDisponiveis(clinicaId, data, ignorarAgendamentoId = null) {
  if (!isISODate(data)) throw httpError(400, 'Data inválida');
  const c = db.prepare('SELECT * FROM clinicas WHERE id = ? AND ativo = 1').get(clinicaId);
  if (!c) throw httpError(404, 'Clínica não encontrada');
  if (data < hoje()) return [];
  const dia = dataHora(data, '00:00').getDay();
  if (!c.dias_semana.split(',').map(Number).includes(dia)) return [];
  const ocupados = {};
  for (const r of db
    .prepare(`SELECT hora, COUNT(*) n FROM agendamentos WHERE clinica_id = ? AND data = ? AND status != 'cancelado' AND id != ? GROUP BY hora`)
    .all(clinicaId, data, ignorarAgendamentoId || 0)) {
    ocupados[r.hora] = r.n;
  }
  const agora = new Date();
  return horariosDoDia(c).filter((h) => (ocupados[h] || 0) < c.capacidade_horario && dataHora(data, h) > agora);
}

function datasDisponiveis(clinicaId, dias = 30) {
  const out = [];
  const base = new Date();
  for (let i = 0; i <= dias; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const livres = horariosDisponiveis(clinicaId, iso).length;
    if (livres > 0) out.push({ data: iso, vagas: livres });
  }
  return out;
}

/** Lista clínicas ativas com valor do exame e endereço. */
function clinicasDisponiveis(tipoId, cidade) {
  const params = [];
  let sql = 'SELECT * FROM clinicas WHERE ativo = 1';
  if (cidade) {
    sql += ' AND lower(cidade) = lower(?)';
    params.push(cidade);
  }
  return db.prepare(sql + ' ORDER BY nome').all(...params).map((c) => ({
    id: c.id,
    nome: c.nome,
    endereco: c.endereco,
    bairro: c.bairro,
    cidade: c.cidade,
    uf: c.uf,
    cep: c.cep,
    telefone: c.telefone,
    maps_url: mapsUrl(c),
    valor: tipoId ? precoExame(c.id, tipoId) : null,
    hora_inicio: c.hora_inicio,
    hora_fim: c.hora_fim,
  }));
}

/* ------------------------------------------------------------------ */
/* NR-7: identificação automática do tipo de exame                      */
/* ------------------------------------------------------------------ */

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

function ultimoASO(funcionarioId) {
  return db
    .prepare(
      `SELECT a.*, t.nome AS tipo_nome, t.codigo AS tipo_codigo FROM asos a JOIN tipos_exame t ON t.id = a.tipo_exame_id
       WHERE a.funcionario_id = ? ORDER BY a.data_emissao DESC, a.id DESC LIMIT 1`,
    )
    .get(funcionarioId);
}

/**
 * Sugere o tipo de exame com base no histórico do funcionário:
 * sem cadastro/demitido → admissional; afastado → retorno ao trabalho;
 * função diferente da registrada → mudança de função; demais → periódico.
 */
function sugerirTipo(empresaId, cpf, funcao) {
  const f = db.prepare('SELECT * FROM funcionarios WHERE empresa_id = ? AND cpf = ?').get(empresaId, digits(cpf));
  const avisos = [];
  if (!f) return { codigo: 'admissional', motivo: 'Funcionário sem cadastro nesta empresa.', funcionario: null, ultimo_aso: null, avisos };
  const aso = ultimoASO(f.id);
  let codigo;
  let motivo;
  if (f.situacao === 'demitido') {
    codigo = 'admissional';
    motivo = 'Funcionário consta como desligado: nova admissão.';
  } else if (f.situacao === 'afastado') {
    codigo = 'retorno_trabalho';
    motivo = 'Funcionário consta como afastado.';
    avisos.push('NR-7: o exame de retorno é obrigatório antes da volta ao trabalho após afastamento igual ou superior a 30 dias por doença ou acidente.');
  } else if (funcao && norm(funcao) !== norm(f.funcao)) {
    codigo = 'mudanca_funcao';
    motivo = `Função informada (${funcao}) difere da registrada (${f.funcao}).`;
    avisos.push('NR-7: o exame de mudança de risco ocupacional deve ser realizado antes da data da mudança.');
  } else if (!aso) {
    codigo = 'admissional';
    motivo = 'Funcionário sem ASO registrado.';
  } else {
    codigo = 'periodico';
    motivo = aso.data_validade
      ? `Último ASO (${aso.tipo_nome}) válido até ${fmtData(aso.data_validade)}.`
      : `Último ASO: ${aso.tipo_nome} em ${fmtData(aso.data_emissao)}.`;
  }
  if (aso && diasEntre(aso.data_emissao, hoje()) <= 90) {
    avisos.push(
      `NR-7: o exame demissional pode ser dispensado se o último exame clínico (${fmtData(aso.data_emissao)}) tiver sido feito há menos de 135 dias (grau de risco 1 e 2) ou 90 dias (grau de risco 3 e 4).`,
    );
  }
  return { codigo, motivo, funcionario: f, ultimo_aso: aso || null, avisos };
}

/* ------------------------------------------------------------------ */
/* Agendamento                                                          */
/* ------------------------------------------------------------------ */

const CAMPOS_EMPRESA = { cnpj: 'CNPJ', razao_social: 'Razão Social', responsavel: 'Nome do Responsável', telefone: 'Telefone', email: 'E-mail' };
const CAMPOS_FUNC = {
  nome: 'Nome Completo', rg: 'RG', cpf: 'CPF', telefone: 'Telefone', data_nascimento: 'Data de Nascimento', funcao: 'Função/Cargo',
};

function salvarEmpresa(dados) {
  exigir(dados, Object.keys(CAMPOS_EMPRESA), CAMPOS_EMPRESA);
  const cnpj = digits(dados.cnpj);
  if (!validaCNPJ(cnpj)) throw httpError(400, 'CNPJ inválido');
  const existente = db.prepare('SELECT id FROM empresas WHERE cnpj = ?').get(cnpj);
  if (existente) {
    db.prepare('UPDATE empresas SET razao_social = ?, responsavel = ?, telefone = ?, email = ? WHERE id = ?')
      .run(dados.razao_social.trim(), dados.responsavel.trim(), dados.telefone.trim(), dados.email.trim(), existente.id);
    return existente.id;
  }
  return Number(
    db.prepare('INSERT INTO empresas (cnpj, razao_social, responsavel, telefone, email) VALUES (?, ?, ?, ?, ?)')
      .run(cnpj, dados.razao_social.trim(), dados.responsavel.trim(), dados.telefone.trim(), dados.email.trim()).lastInsertRowid,
  );
}

function salvarFuncionario(empresaId, dados, { atualizarFuncao = true } = {}) {
  exigir(dados, Object.keys(CAMPOS_FUNC), CAMPOS_FUNC);
  const cpf = digits(dados.cpf);
  if (!validaCPF(cpf)) throw httpError(400, 'CPF inválido');
  if (!isISODate(dados.data_nascimento)) throw httpError(400, 'Data de nascimento inválida');
  const f = db.prepare('SELECT * FROM funcionarios WHERE empresa_id = ? AND cpf = ?').get(empresaId, cpf);
  if (f) {
    db.prepare('UPDATE funcionarios SET nome = ?, rg = ?, telefone = ?, email = ?, data_nascimento = ?, funcao = ? WHERE id = ?').run(
      dados.nome.trim(), dados.rg.trim(), dados.telefone.trim(), (dados.email || f.email || '').trim() || null,
      dados.data_nascimento, atualizarFuncao ? dados.funcao.trim() : f.funcao, f.id,
    );
    return f.id;
  }
  return Number(
    db.prepare(
      'INSERT INTO funcionarios (empresa_id, nome, rg, cpf, telefone, email, data_nascimento, funcao) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(empresaId, dados.nome.trim(), dados.rg.trim(), cpf, dados.telefone.trim(), (dados.email || '').trim() || null, dados.data_nascimento, dados.funcao.trim())
      .lastInsertRowid,
  );
}

function registrarHistorico(funcionarioId, evento, { descricao, funcao_anterior, funcao_nova, agendamento_id, data } = {}) {
  db.prepare(
    'INSERT INTO historico_funcional (funcionario_id, evento, descricao, funcao_anterior, funcao_nova, agendamento_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(funcionarioId, evento, descricao || null, funcao_anterior || null, funcao_nova || null, agendamento_id || null, data || hoje());
}

function payloadPixAgendamento(ag) {
  const c = db.prepare('SELECT * FROM clinicas WHERE id = ?').get(ag.clinica_id);
  const fin = dadosFinanceiros(c);
  if (!fin.pix_chave) return null;
  return gerarPayloadPix({
    chave: fin.pix_chave, nome: fin.pix_nome, cidade: fin.pix_cidade, valor: ag.valor,
    txid: ag.codigo.replace(/-/g, ''), descricao: `Exame ${ag.codigo}`,
  });
}

/**
 * Cria o agendamento (empresa + funcionário + exame + clínica + data/hora).
 * Retorna o id; a geração do PDF e o envio são feitos por finalizarAgendamento().
 */
function criarAgendamento(user, body) {
  const { clinica_id, data, hora } = body;
  exigir(body, ['tipo_exame', 'clinica_id', 'data', 'hora'], { tipo_exame: 'Tipo de Exame', clinica_id: 'Clínica', data: 'Data', hora: 'Horário' });
  const tipo = tipoPorCodigoOuId(body.tipo_exame);
  if (tipo.categoria !== 'ocupacional') throw httpError(400, 'Selecione um tipo de exame ocupacional (NR-7)');

  return tx(() => {
    let empresaId;
    if (user.perfil === 'empresa') {
      empresaId = user.empresa_id;
      if (body.empresa) salvarEmpresa({ ...body.empresa, cnpj: db.prepare('SELECT cnpj FROM empresas WHERE id = ?').get(empresaId).cnpj });
    } else {
      if (!body.empresa) throw httpError(400, 'Informe os dados da empresa');
      empresaId = body.empresa.id ? Number(body.empresa.id) : salvarEmpresa(body.empresa);
    }

    const fDados = body.funcionario || {};
    const existente = db.prepare('SELECT * FROM funcionarios WHERE empresa_id = ? AND cpf = ?').get(empresaId, digits(fDados.cpf));
    let funcaoAtual = fDados.funcao;
    let funcaoNova = null;
    if (tipo.codigo === 'mudanca_funcao') {
      funcaoNova = String(body.funcao_nova || '').trim();
      if (!funcaoNova) throw httpError(400, 'Informe a nova função para o exame de Mudança de Função');
      funcaoAtual = existente ? existente.funcao : fDados.funcao;
    }
    // Na mudança de função, a função cadastrada só muda após a emissão do ASO.
    const funcId = salvarFuncionario(empresaId, fDados, { atualizarFuncao: tipo.codigo !== 'mudanca_funcao' || !existente });

    const pendente = db
      .prepare(`SELECT codigo FROM agendamentos WHERE funcionario_id = ? AND tipo_exame_id = ? AND status IN ('agendado','compareceu','em_atendimento')`)
      .get(funcId, tipo.id);
    if (pendente) throw httpError(409, `Já existe um agendamento em aberto deste exame para o funcionário (${pendente.codigo})`);

    if (!horariosDisponiveis(Number(clinica_id), data).includes(hora)) throw httpError(409, 'Horário indisponível. Escolha outro horário.');

    const valor = precoExame(Number(clinica_id), tipo.id);
    const codigo = gerarCodigo();
    const id = Number(
      db.prepare(
        `INSERT INTO agendamentos (codigo, empresa_id, funcionario_id, clinica_id, tipo_exame_id, funcao_atual, funcao_nova, data, hora, valor, observacoes_empresa, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(codigo, empresaId, funcId, Number(clinica_id), tipo.id, funcaoAtual, funcaoNova, data, hora, valor, body.observacoes || null, user.id)
        .lastInsertRowid,
    );
    const ag = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
    db.prepare('UPDATE agendamentos SET pix_payload = ? WHERE id = ?').run(payloadPixAgendamento(ag), id);
    return id;
  });
}

/* ------------------------------------------------------------------ */
/* Riscos ocupacionais por função (PGR)                                 */
/* ------------------------------------------------------------------ */

const CATEGORIAS_RISCO = [
  ['fisicos', 'Físicos'], ['quimicos', 'Químicos'], ['biologicos', 'Biológicos'], ['ergonomicos', 'Ergonômicos'], ['acidentes', 'Acidentes'],
];

/** Normaliza o nome da função para comparar ("Aux. de Pedreiro" = "AUX DE PEDREIRO"). */
const normFuncao = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Texto dos riscos, uma categoria por linha; vazio se nada cadastrado. */
function textoRiscos(r) {
  if (!r) return '';
  return CATEGORIAS_RISCO.filter(([k]) => String(r[k] || '').trim()).map(([k, rot]) => `${rot}: ${String(r[k]).trim()}`).join('\n');
}

function riscoCadastrado(empresaId, funcao) {
  if (!funcao) return null;
  return db.prepare('SELECT * FROM riscos_funcao WHERE empresa_id = ? AND funcao_norm = ?').get(empresaId, normFuncao(funcao)) || null;
}

function salvarRiscoFuncao(empresaId, dados, origem = 'manual') {
  const funcao = String(dados.funcao || '').trim();
  if (!funcao) throw httpError(400, 'Informe a função');
  const v = Object.fromEntries(CATEGORIAS_RISCO.map(([k]) => [k, String(dados[k] || '').trim() || null]));
  db.prepare(
    `INSERT INTO riscos_funcao (empresa_id, funcao, funcao_norm, fisicos, quimicos, biologicos, ergonomicos, acidentes, origem)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(empresa_id, funcao_norm) DO UPDATE SET funcao = excluded.funcao, fisicos = excluded.fisicos, quimicos = excluded.quimicos,
       biologicos = excluded.biologicos, ergonomicos = excluded.ergonomicos, acidentes = excluded.acidentes, updated_at = datetime('now','localtime')`,
  ).run(empresaId, funcao, normFuncao(funcao), v.fisicos, v.quimicos, v.biologicos, v.ergonomicos, v.acidentes, origem);
  return db.prepare('SELECT * FROM riscos_funcao WHERE empresa_id = ? AND funcao_norm = ?').get(empresaId, normFuncao(funcao));
}

/** Liga a empresa ao cadastro do eSocial Brasil (pelo CNPJ) e guarda o id. */
async function esocialIdDaEmpresa(empresaId) {
  const esocial = require('./esocial');
  const e = db.prepare('SELECT id, cnpj, esocial_id FROM empresas WHERE id = ?').get(empresaId);
  if (!e) return null;
  if (e.esocial_id) return e.esocial_id;
  if (!esocial.configurado()) return null;
  const es = await esocial.empresaPorCnpj(e.cnpj);
  if (es) db.prepare('UPDATE empresas SET esocial_id = ? WHERE id = ?').run(es.id, empresaId);
  return es ? es.id : null;
}

/**
 * Riscos da função do exame: procura a função informada no cadastro da empresa;
 * se não achar, usa a função registrada no eSocial Brasil para o CPF.
 * Sem cadastro → texto vazio (riscos em branco na guia e no ASO).
 */
async function resolverRiscos(ag) {
  const funcao = ag.tipo_codigo === 'mudanca_funcao' && ag.funcao_nova ? ag.funcao_nova : ag.funcao_atual || ag.func_funcao;
  let r = riscoCadastrado(ag.empresa_id, funcao);
  if (!r && ag.tipo_codigo !== 'mudanca_funcao') {
    try {
      const esId = await esocialIdDaEmpresa(ag.empresa_id);
      const emp = esId ? await require('./esocial').empregado(esId, ag.func_cpf) : null;
      if (emp && emp.funcao) r = riscoCadastrado(ag.empresa_id, emp.funcao);
    } catch (e) {
      console.error('[esocial]', e.message);
    }
  }
  return textoRiscos(r);
}

/** Cria (em branco) no cadastro de riscos as funções que a empresa tem no eSocial Brasil. */
async function importarFuncoesEsocial(empresaId) {
  const esocial = require('./esocial');
  if (!esocial.configurado()) throw httpError(400, 'Integração com o eSocial Brasil não configurada (ESOCIAL_TOKEN)');
  const esId = await esocialIdDaEmpresa(empresaId);
  if (!esId) throw httpError(404, 'Empresa não encontrada no eSocial Brasil pelo CNPJ');
  const funcoes = await esocial.funcoesDaEmpresa(esId);
  let novas = 0;
  for (const f of funcoes) {
    if (!riscoCadastrado(empresaId, f)) { salvarRiscoFuncao(empresaId, { funcao: f }, 'esocial'); novas++; }
  }
  return { encontradas: funcoes.length, novas };
}

/** Gera a guia em PDF, registra o documento e dispara os envios. */
async function finalizarAgendamento(id, { evento = 'novo' } = {}) {
  const { gerarGuia } = require('./pdf');
  const notify = require('./notify');
  const pre = buscarAgendamento(id);
  if (!pre.aso_id) db.prepare('UPDATE agendamentos SET riscos = ? WHERE id = ?').run(await resolverRiscos(pre), id);
  const ag = buscarAgendamento(id);
  const arquivo = await gerarGuia(ag, { fin: dadosFinanceiros(db.prepare('SELECT * FROM clinicas WHERE id = ?').get(ag.clinica_id)), maps: mapsUrl(clinicaDe(ag)) });
  db.prepare('UPDATE agendamentos SET guia_path = ? WHERE id = ?').run(arquivo, id);
  db.prepare("DELETE FROM documentos WHERE agendamento_id = ? AND tipo = 'guia'").run(id);
  db.prepare("INSERT INTO documentos (agendamento_id, funcionario_id, tipo, nome, arquivo, mime) VALUES (?, ?, 'guia', ?, ?, 'application/pdf')")
    .run(id, ag.funcionario_id, `Guia de Encaminhamento ${ag.codigo}.pdf`, arquivo);
  await notify.enviarGuia(buscarAgendamento(id), evento).catch((e) => console.error('[notify]', e.message));
  return buscarAgendamento(id);
}

function clinicaDe(ag) {
  return db.prepare('SELECT * FROM clinicas WHERE id = ?').get(ag.clinica_id);
}

function reagendar(user, id, { data, hora, clinica_id }) {
  const ag = buscarAgendamento(id);
  checarAcessoAgendamento(user, ag);
  if (!['agendado', 'ausente'].includes(ag.status)) throw httpError(400, 'Só é possível reagendar exames agendados ou com ausência');
  const novaClinica = user.perfil === 'clinica' ? ag.clinica_id : Number(clinica_id || ag.clinica_id);
  exigir({ data, hora }, ['data', 'hora'], { data: 'Data', hora: 'Horário' });
  if (!horariosDisponiveis(novaClinica, data, id).includes(hora)) throw httpError(409, 'Horário indisponível');
  const valor = novaClinica !== ag.clinica_id ? precoExame(novaClinica, ag.tipo_exame_id) : ag.valor;
  db.prepare(`UPDATE agendamentos SET data = ?, hora = ?, clinica_id = ?, valor = ?, status = 'agendado', updated_at = ? WHERE id = ?`)
    .run(data, hora, novaClinica, valor, agoraISO(), id);
  const atualizado = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  db.prepare('UPDATE agendamentos SET pix_payload = ? WHERE id = ?').run(payloadPixAgendamento(atualizado), id);
  // Lembretes devem ser reenviados para a nova data
  db.prepare("DELETE FROM alertas_enviados WHERE chave LIKE ?").run(`lembrete:${id}:%`);
}

/* ------------------------------------------------------------------ */
/* ASO                                                                  */
/* ------------------------------------------------------------------ */

function hashAssinatura(aso, medico, assinadoEm) {
  const canonico = JSON.stringify({
    aso: aso.id, agendamento: aso.agendamento_id, funcionario: aso.funcionario_id, tipo: aso.tipo_exame_id,
    conclusao: aso.conclusao, restricoes: aso.restricoes || '', emissao: aso.data_emissao, validade: aso.data_validade || '',
    medico: medico.id, crm: `${medico.crm}/${medico.uf_crm}`, assinado_em: assinadoEm,
  });
  return crypto.createHash('sha256').update(canonico).digest('hex');
}

function buscarASO(id) {
  const a = db
    .prepare(
      `SELECT s.*, t.nome AS tipo_nome, t.codigo AS tipo_codigo,
        f.nome AS func_nome, f.cpf AS func_cpf, f.rg AS func_rg, f.data_nascimento AS func_nascimento,
        e.razao_social, e.cnpj,
        m.nome AS medico_nome, m.crm AS medico_crm, m.uf_crm AS medico_uf_crm,
        ag.codigo AS agendamento_codigo, ag.clinica_id, ag.data AS exame_data,
        c.nome AS clinica_nome, c.endereco AS clinica_endereco, c.cidade AS clinica_cidade, c.uf AS clinica_uf, c.telefone AS clinica_telefone
       FROM asos s
       JOIN tipos_exame t ON t.id = s.tipo_exame_id
       JOIN funcionarios f ON f.id = s.funcionario_id
       JOIN empresas e ON e.id = s.empresa_id
       JOIN agendamentos ag ON ag.id = s.agendamento_id
       JOIN clinicas c ON c.id = ag.clinica_id
       LEFT JOIN medicos m ON m.id = s.medico_id
       WHERE s.id = ?`,
    )
    .get(id);
  if (!a) throw httpError(404, 'ASO não encontrado');
  return a;
}

/** Emite o ASO e atualiza o histórico do funcionário conforme o tipo NR-7. */
async function emitirASO(user, agendamentoId, body) {
  const ag = buscarAgendamento(agendamentoId);
  checarAcessoAgendamento(user, ag);
  if (user.perfil === 'empresa') throw httpError(403, 'Empresa não emite ASO');
  if (ag.status === 'cancelado') throw httpError(400, 'Agendamento cancelado');
  if (ag.status_pagamento !== 'pagamento_confirmado') throw httpError(400, 'O ASO só pode ser emitido após a confirmação do pagamento');
  if (ag.aso_id) throw httpError(409, 'ASO já emitido para este agendamento');
  if (ag.data > hoje()) throw httpError(400, 'O ASO só pode ser emitido a partir da data do exame');
  if (!['compareceu', 'em_atendimento'].includes(ag.status)) throw httpError(400, 'Registre o comparecimento do funcionário antes de emitir o ASO');
  if (!['apto', 'inapto', 'apto_com_restricao'].includes(body.conclusao)) throw httpError(400, 'Informe a conclusão: apto, inapto ou apto com restrição');
  if (body.conclusao === 'apto_com_restricao' && !String(body.restricoes || '').trim()) throw httpError(400, 'Descreva as restrições');

  let medicoId = user.perfil === 'medico' ? user.medico_id : Number(body.medico_id || ag.medico_id || 0) || null;
  if (!medicoId) throw httpError(400, 'Selecione o médico responsável pelo ASO');
  const medico = db.prepare('SELECT * FROM medicos WHERE id = ?').get(medicoId);
  if (!medico) throw httpError(400, 'Médico inválido');

  const tipo = db.prepare('SELECT * FROM tipos_exame WHERE id = ?').get(ag.tipo_exame_id);
  const emissao = hoje();
  const validade = tipo.validade_meses ? addMeses(emissao, Number(body.validade_meses || tipo.validade_meses)) : null;
  const exames =
    body.exames_realizados ||
    db.prepare('SELECT exame, resultado FROM resultados WHERE agendamento_id = ?').all(agendamentoId).map((r) => `${r.exame}${r.resultado ? `: ${r.resultado}` : ''}`).join('; ') ||
    'Exame clínico ocupacional';
  const funcao = tipo.codigo === 'mudanca_funcao' && ag.funcao_nova ? ag.funcao_nova : ag.func_funcao;

  const asoId = tx(() => {
    const id = Number(
      db.prepare(
        `INSERT INTO asos (agendamento_id, funcionario_id, empresa_id, medico_id, tipo_exame_id, funcao, riscos, exames_realizados, conclusao, restricoes, observacoes, data_emissao, data_validade, emitido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(agendamentoId, ag.funcionario_id, ag.empresa_id, medicoId, tipo.id, funcao, String(body.riscos ?? ag.riscos ?? '').trim(),
        exames, body.conclusao, body.restricoes || null, body.observacoes || null, emissao, validade, user.id).lastInsertRowid,
    );
    db.prepare(`UPDATE agendamentos SET status = 'realizado', medico_id = ?, updated_at = ? WHERE id = ?`).run(medicoId, agoraISO(), agendamentoId);

    const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(ag.funcionario_id);
    const desc = `ASO ${tipo.nome} — ${body.conclusao.replace(/_/g, ' ')}`;
    registrarHistorico(f.id, 'exame_realizado', { descricao: `${tipo.nome}: ${exames}`, agendamento_id: agendamentoId, data: emissao });
    registrarHistorico(f.id, 'aso_emitido', { descricao: desc, agendamento_id: agendamentoId, data: emissao });
    switch (tipo.codigo) {
      case 'admissional':
        db.prepare("UPDATE funcionarios SET situacao = 'ativo', data_admissao = COALESCE(data_admissao, ?), data_demissao = NULL WHERE id = ?").run(emissao, f.id);
        registrarHistorico(f.id, 'admissao', { descricao: `Admissão na função ${f.funcao}`, agendamento_id: agendamentoId, data: emissao });
        break;
      case 'demissional':
        db.prepare("UPDATE funcionarios SET situacao = 'demitido', data_demissao = ? WHERE id = ?").run(emissao, f.id);
        registrarHistorico(f.id, 'demissao', { descricao: 'Exame demissional realizado', agendamento_id: agendamentoId, data: emissao });
        break;
      case 'mudanca_funcao':
        if (ag.funcao_nova) {
          db.prepare('UPDATE funcionarios SET funcao = ? WHERE id = ?').run(ag.funcao_nova, f.id);
          registrarHistorico(f.id, 'mudanca_funcao', { descricao: 'Mudança de função', funcao_anterior: ag.funcao_atual || f.funcao, funcao_nova: ag.funcao_nova, agendamento_id: agendamentoId, data: emissao });
        }
        break;
      case 'retorno_trabalho':
        db.prepare("UPDATE funcionarios SET situacao = 'ativo' WHERE id = ?").run(f.id);
        registrarHistorico(f.id, 'retorno_trabalho', { descricao: 'Retorno ao trabalho', agendamento_id: agendamentoId, data: emissao });
        break;
      case 'periodico':
        registrarHistorico(f.id, 'periodico', { descricao: 'Exame periódico realizado', agendamento_id: agendamentoId, data: emissao });
        break;
      default:
        break;
    }
    // Novo ASO reinicia os alertas de vencimento do funcionário
    return id;
  });

  if (user.perfil === 'medico') return assinarASO(user, asoId);
  await gerarArquivoASO(asoId);
  const notify = require('./notify');
  notify.enviarASO(buscarASO(asoId)).catch((e) => console.error('[notify]', e.message));
  return buscarASO(asoId);
}

async function gerarArquivoASO(asoId) {
  const { gerarASOPdf } = require('./pdf');
  const aso = buscarASO(asoId);
  const arquivo = await gerarASOPdf(aso);
  db.prepare('UPDATE asos SET arquivo = ? WHERE id = ?').run(arquivo, asoId);
  db.prepare("DELETE FROM documentos WHERE agendamento_id = ? AND tipo = 'aso'").run(aso.agendamento_id);
  db.prepare("INSERT INTO documentos (agendamento_id, funcionario_id, tipo, nome, arquivo, mime) VALUES (?, ?, 'aso', ?, ?, 'application/pdf')")
    .run(aso.agendamento_id, aso.funcionario_id, `ASO ${aso.tipo_nome} - ${aso.func_nome}.pdf`, arquivo);
  return arquivo;
}

/** Assinatura eletrônica do médico: hash SHA-256 dos dados do ASO + médico + data/hora. */
async function assinarASO(user, asoId) {
  if (user.perfil !== 'medico') throw httpError(403, 'Apenas médicos assinam o ASO');
  const aso = buscarASO(asoId);
  if (aso.hash_assinatura) throw httpError(409, 'ASO já assinado');
  const medico = db.prepare('SELECT * FROM medicos WHERE id = ?').get(user.medico_id);
  if (aso.medico_id && aso.medico_id !== medico.id) throw httpError(403, 'Este ASO está sob responsabilidade de outro médico');
  if (aso.clinica_id !== medico.clinica_id) throw httpError(403, 'ASO de outra clínica');
  const em = agoraISO();
  const hash = hashAssinatura(aso, medico, em);
  db.prepare('UPDATE asos SET hash_assinatura = ?, assinado_por = ?, assinado_em = ?, medico_id = ? WHERE id = ?').run(hash, medico.id, em, medico.id, asoId);
  await gerarArquivoASO(asoId);
  const notify = require('./notify');
  notify.enviarASO(buscarASO(asoId)).catch((e) => console.error('[notify]', e.message));
  return buscarASO(asoId);
}

/* ------------------------------------------------------------------ */
/* Vencimentos (PCMSO)                                                  */
/* ------------------------------------------------------------------ */

/** Situação do último ASO de cada funcionário ativo. */
function vencimentos({ empresaId } = {}) {
  const params = [];
  let filtro = "f.situacao != 'demitido'";
  if (empresaId) {
    filtro += ' AND f.empresa_id = ?';
    params.push(empresaId);
  }
  const rows = db
    .prepare(
      `SELECT f.id AS funcionario_id, f.nome, f.cpf, f.funcao, f.telefone, f.email, f.empresa_id, e.razao_social,
        s.id AS aso_id, s.data_emissao, s.data_validade, t.nome AS tipo_nome,
        (SELECT a.codigo || ' em ' || a.data FROM agendamentos a WHERE a.funcionario_id = f.id AND a.status = 'agendado' AND a.data >= date('now','localtime') ORDER BY a.data LIMIT 1) AS proximo_agendamento
       FROM funcionarios f
       JOIN empresas e ON e.id = f.empresa_id
       LEFT JOIN asos s ON s.id = (SELECT id FROM asos WHERE funcionario_id = f.id ORDER BY data_emissao DESC, id DESC LIMIT 1)
       LEFT JOIN tipos_exame t ON t.id = s.tipo_exame_id
       WHERE ${filtro}
       ORDER BY s.data_validade IS NULL, s.data_validade`,
    )
    .all(...params);
  const h = hoje();
  return rows.map((r) => {
    let situacao = 'sem_aso';
    let dias = null;
    if (r.data_validade) {
      dias = diasEntre(h, r.data_validade);
      situacao = dias < 0 ? 'vencido' : dias <= 90 ? 'a_vencer' : 'em_dia';
    } else if (r.aso_id) situacao = 'em_dia';
    return { ...r, dias_para_vencer: dias, situacao };
  });
}

module.exports = {
  AG_SELECT, buscarAgendamento, checarAcessoAgendamento, clinicaDoMedico, tipoPorCodigoOuId, precoExame, dadosFinanceiros, mapsUrl,
  horariosDisponiveis, datasDisponiveis, clinicasDisponiveis, sugerirTipo, salvarEmpresa, salvarFuncionario, registrarHistorico,
  criarAgendamento, finalizarAgendamento, reagendar, buscarASO, emitirASO, assinarASO, gerarArquivoASO, vencimentos, ultimoASO,
  payloadPixAgendamento, CATEGORIAS_RISCO, normFuncao, textoRiscos, riscoCadastrado, salvarRiscoFuncao, resolverRiscos, importarFuncoesEsocial,
};
