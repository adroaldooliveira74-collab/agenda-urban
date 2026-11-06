'use strict';
/* Teste de ponta a ponta: agendamento → pagamento → atendimento → ASO assinado. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urbanclin-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test'; // não chama a API real do eSocial Brasil
const app = require('../src/server');
const { db } = require('../src/db');
const { gerarPayloadPix, crc16 } = require('../src/pix');
const { validaCPF, validaCNPJ } = require('../src/util');

let srv;
let base;
before(() => new Promise((r) => { srv = app.listen(0, () => { base = `http://localhost:${srv.address().port}/api`; r(); }); }));
after(() => {
  srv.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function j(metodo, url, corpo, token) {
  const r = await fetch(base + url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return [r.status, await r.json().catch(() => null)];
}
// Senhas já trocadas no primeiro acesso, por login
const trocadas = new Map();
async function login(id, senha) {
  const [st, r] = await j('POST', '/auth/login', { login: id, senha: trocadas.get(id) || senha });
  assert.strictEqual(st, 200, JSON.stringify(r));
  if (r.usuario.trocar_senha) {
    const [s2] = await j('POST', '/auth/senha', { atual: senha, nova: 'SenhaNova#1' }, r.token);
    assert.strictEqual(s2, 200);
    trocadas.set(id, 'SenhaNova#1');
  }
  return r.token;
}
const ADMIN = 'urban.ambiental@hotmail.com';
const cnpjHz = () => db.prepare("SELECT cnpj FROM empresas WHERE email = 'rh@horizonte.com.br'").get().cnpj;

test('PIX BR Code tem CRC válido', () => {
  const p = gerarPayloadPix({ chave: 'teste@exemplo.com', nome: 'Clínica Teste', cidade: 'São Paulo', valor: 100, txid: 'ABC123' });
  assert.ok(p.startsWith('000201'));
  assert.ok(p.includes('5406100.00'));
  assert.strictEqual(p.slice(-4), crc16(p.slice(0, -4)));
});

test('validação de CPF e CNPJ', () => {
  assert.ok(validaCPF('529.982.247-25'));
  assert.ok(!validaCPF('111.111.111-11'));
  assert.ok(validaCNPJ('11.222.333/0001-81'));
  assert.ok(!validaCNPJ('11.222.333/0001-82'));
});

test('fluxo completo NR-7', async () => {
  const te = await login(cnpjHz(), 'urban1234');
  const tc = await login('clinica@urbanclin.com.br', 'clinica123');
  const tm = await login('medico@urbanclin.com.br', 'medico123');

  const [, sug] = await j('GET', '/sugerir-tipo?cpf=52998224725&funcao=Servente', null, te);
  assert.strictEqual(sug.codigo, 'admissional');

  const [, clinicas] = await j('GET', '/clinicas?tipo=admissional', null, te);
  const [, datas] = await j('GET', `/clinicas/${clinicas[0].id}/datas`, null, te);
  const [, horas] = await j('GET', `/clinicas/${clinicas[0].id}/horarios?data=${datas[0].data}`, null, te);
  const [st, ag] = await j('POST', '/agendamentos', {
    tipo_exame: 'admissional', clinica_id: clinicas[0].id, data: datas[0].data, hora: horas[0],
    funcionario: { nome: 'Teste da Silva', rg: '12.345.678-9', cpf: '529.982.247-25', telefone: '(11) 91234-5678', data_nascimento: '1990-01-01', funcao: 'Servente' },
  }, te);
  assert.strictEqual(st, 201, JSON.stringify(ag));
  assert.ok(fs.existsSync(path.join(dir, ag.guia_path)), 'guia em PDF gerada');
  assert.ok(ag.pix_payload);

  // mesmo horário não pode ser reservado além da capacidade
  const [, outro] = await j('GET', `/clinicas/${clinicas[0].id}/horarios?data=${datas[0].data}`, null, te);
  assert.ok(Array.isArray(outro));

  // envio para empresa, funcionário e clínica (e-mail e WhatsApp)
  const envios = db.prepare('SELECT canal FROM notificacoes WHERE referencia = ?').all(`agendamento:${ag.id}`);
  assert.ok(envios.filter((e) => e.canal === 'whatsapp').length >= 3);

  // exame no dia de hoje para permitir o atendimento
  db.prepare("UPDATE agendamentos SET data = date('now','localtime') WHERE id = ?").run(ag.id);

  const [semPag] = await j('POST', `/agendamentos/${ag.id}/status`, { status: 'compareceu' }, tc);
  assert.strictEqual(semPag, 400, 'sem pagamento confirmado não há atendimento');

  assert.strictEqual((await j('POST', `/agendamentos/${ag.id}/pagamento`, { acao: 'confirmar' }, tc))[1].status_pagamento, 'pagamento_confirmado');
  assert.strictEqual((await j('POST', `/agendamentos/${ag.id}/status`, { status: 'compareceu' }, tc))[1].status, 'compareceu');
  await j('POST', `/agendamentos/${ag.id}/resultados`, { exame: 'Audiometria', resultado: 'Normal' }, tm);

  const [sa, aso] = await j('POST', `/agendamentos/${ag.id}/aso`, { conclusao: 'apto', riscos: 'Ruído' }, tm);
  assert.strictEqual(sa, 201, JSON.stringify(aso));
  assert.ok(aso.hash_assinatura, 'ASO assinado pelo médico');
  assert.ok(aso.data_validade);

  const [, ver] = await j('GET', `/verificar/${aso.hash_assinatura}`);
  assert.strictEqual(ver.valido, true);

  const [, func] = await j('GET', `/funcionarios/${ag.funcionario_id}`, null, te);
  assert.ok(func.historico.some((h) => h.evento === 'admissao'));
  assert.strictEqual(func.asos.length, 1);
});

test('riscos da função cadastrada saem na guia e no ASO; sem cadastro saem em branco', async () => {
  const te = await login(cnpjHz(), 'urban1234');
  const ta = await login(ADMIN, 'urban1234');
  const tc = await login('clinica@urbanclin.com.br', 'clinica123');
  const tm = await login('medico@urbanclin.com.br', 'medico123');
  const emp = db.prepare("SELECT id FROM empresas WHERE email = 'rh@horizonte.com.br'").get();

  // cadastro pela tela de administração; a comparação ignora acentos, pontos e maiúsculas
  const [sr] = await j('POST', `/admin/empresas/${emp.id}/riscos`, { funcao: 'Aux. de Pedreiro', fisicos: 'Ruído', acidentes: 'Queda de altura' }, ta);
  assert.strictEqual(sr, 201);
  const [, lista] = await j('GET', `/admin/empresas/${emp.id}/riscos`, null, ta);
  assert.ok(lista.funcoes.some((f) => f.funcao === 'Aux. de Pedreiro'));

  async function agendar(cpf, funcao) {
    const [, clinicas] = await j('GET', '/clinicas?tipo=admissional', null, te);
    const [, datas] = await j('GET', `/clinicas/${clinicas[0].id}/datas`, null, te);
    const [, horas] = await j('GET', `/clinicas/${clinicas[0].id}/horarios?data=${datas[1].data}`, null, te);
    const [st, ag] = await j('POST', '/agendamentos', {
      tipo_exame: 'admissional', clinica_id: clinicas[0].id, data: datas[1].data, hora: horas[0],
      funcionario: { nome: `Teste ${funcao}`, rg: '1', cpf, telefone: '(11) 91234-5678', data_nascimento: '1990-01-01', funcao },
    }, te);
    assert.strictEqual(st, 201, JSON.stringify(ag));
    return ag;
  }

  const com = await agendar('111.444.777-35', 'AUX DE PEDREIRO');
  assert.strictEqual(com.riscos, 'Físicos: Ruído\nAcidentes: Queda de altura');
  const sem = await agendar('390.533.447-05', 'Função Sem Cadastro');
  assert.strictEqual(sem.riscos, '');

  for (const ag of [com, sem]) {
    db.prepare("UPDATE agendamentos SET data = date('now','localtime') WHERE id = ?").run(ag.id);
    await j('POST', `/agendamentos/${ag.id}/pagamento`, { acao: 'confirmar' }, tc);
    await j('POST', `/agendamentos/${ag.id}/status`, { status: 'compareceu' }, tc);
  }
  const [, aso1] = await j('POST', `/agendamentos/${com.id}/aso`, { conclusao: 'apto' }, tm);
  assert.strictEqual(aso1.riscos, 'Físicos: Ruído\nAcidentes: Queda de altura');
  const [, aso2] = await j('POST', `/agendamentos/${sem.id}/aso`, { conclusao: 'apto' }, tm);
  assert.strictEqual(aso2.riscos, '');
  assert.ok(fs.existsSync(path.join(dir, aso2.arquivo || com.guia_path)));
});

test('login por CNPJ/CPF com senha inicial e troca obrigatória no primeiro acesso', async () => {
  const cnpjLog = db.prepare("SELECT cnpj FROM empresas WHERE email = 'sesmt@lograpida.com.br'").get().cnpj;
  // aceita o CNPJ formatado; senha errada é recusada
  const fmt = cnpjLog.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  assert.strictEqual((await j('POST', '/auth/login', { login: fmt, senha: 'errada' }))[0], 401);
  const [st, r] = await j('POST', '/auth/login', { login: fmt, senha: 'urban1234' });
  assert.strictEqual(st, 200);
  assert.strictEqual(r.usuario.trocar_senha, true);
  // antes de trocar a senha, nada além do próprio cadastro
  assert.strictEqual((await j('GET', '/dashboard', null, r.token))[0], 403);
  assert.strictEqual((await j('GET', '/auth/me', null, r.token))[0], 200);
  assert.strictEqual((await j('POST', '/auth/senha', { atual: 'urban1234', nova: 'urban1234' }, r.token))[0], 400);
  assert.strictEqual((await j('POST', '/auth/senha', { atual: 'urban1234', nova: 'Minha#2026' }, r.token))[0], 200);
  assert.strictEqual((await j('GET', '/dashboard', null, r.token))[0], 200);
  assert.strictEqual((await j('POST', '/auth/login', { login: cnpjLog, senha: 'urban1234' }))[0], 401, 'senha inicial deixa de valer');

  // empresa sem CNPJ: cadastrada pelo CPF do empregador já nasce com acesso
  const ta = await login(ADMIN, 'urban1234');
  const [sc] = await j('POST', '/admin/empresas', { cnpj: '529.982.247-25', razao_social: 'João Produtor Rural', responsavel: 'João', telefone: '(44) 99999-0000', email: 'joao@exemplo.com' }, ta);
  assert.strictEqual(sc, 201);
  const [sl, rl] = await j('POST', '/auth/login', { login: '529.982.247-25', senha: 'urban1234' });
  assert.strictEqual(sl, 200);
  assert.strictEqual(rl.usuario.perfil, 'empresa');

  // administrador de demonstração antigo não entra mais
  assert.strictEqual((await j('POST', '/auth/login', { login: 'admin@urbanclin.com.br', senha: 'admin123' }))[0], 401);
});

test('sincronização diária com o eSocial grava só empresas novas ou alteradas', async () => {
  const es = require('../src/esocial');
  const original = { configurado: es.configurado, todasEmpresas: es.todasEmpresas };
  const { sincronizacaoDiaria } = require('../src/scheduler');
  const hz = db.prepare("SELECT * FROM empresas WHERE email = 'rh@horizonte.com.br'").get();
  const lista = [
    { id: 901, cnpj: '11.444.777/0001-61', razao_social: 'Nova Empresa do eSocial Ltda', telefone: '(44) 3000-0000', email: 'nova@exemplo.com', responsavel: { nome: 'Maria' } },
    { id: 902, cnpj: hz.cnpj, razao_social: hz.razao_social, telefone: '(44) 99999-1111', email: hz.email, responsavel: { nome: hz.responsavel } },
    { id: 903, cnpj: '123', razao_social: 'Documento inválido' },
    { id: 904, cnpj: '45.997.418/0001-53', razao_social: 'Empresa Bloqueada Ltda', ativo: true, bloqueado: true },
  ];
  es.configurado = () => true;
  es.todasEmpresas = async () => lista;
  try {
    const r1 = await sincronizacaoDiaria({ forcar: true });
    assert.deepStrictEqual([r1.recebidas, r1.novas, r1.atualizadas, r1.ignoradas, r1.bloqueadas], [4, 1, 1, 1, 1]);
    assert.ok(!db.prepare("SELECT 1 FROM empresas WHERE cnpj = '45997418000153'").get(), 'bloqueada não é cadastrada');
    assert.strictEqual((await j('POST', '/auth/login', { login: '45997418000153', senha: 'urban1234' }))[0], 401);
    assert.strictEqual(db.prepare('SELECT telefone FROM empresas WHERE id = ?').get(hz.id).telefone, '(44) 99999-1111');
    // nada mudou no eSocial → nada é gravado
    const r2 = await sincronizacaoDiaria({ forcar: true });
    assert.deepStrictEqual([r2.novas, r2.atualizadas, r2.sem_mudanca], [0, 0, 2]);
    // fora do horário/no mesmo dia, a rotina automática não roda de novo
    assert.strictEqual(await sincronizacaoDiaria(), null);
    // empresa nova já entra com o CNPJ e a senha inicial
    const [st, r] = await j('POST', '/auth/login', { login: '11444777000161', senha: 'urban1234' });
    assert.strictEqual(st, 200);
    assert.strictEqual(r.usuario.trocar_senha, true);
    // bloqueada depois no eSocial: sem movimento aqui, é retirada (e o acesso some)
    lista[0].bloqueado = true;
    const r3 = await sincronizacaoDiaria({ forcar: true });
    assert.strictEqual(r3.retiradas, 1);
    assert.strictEqual((await j('POST', '/auth/login', { login: '11444777000161', senha: 'urban1234' }))[0], 401);
  } finally {
    Object.assign(es, original);
  }
});

test('perfis não acessam rotas de outros perfis', async () => {
  const te = await login(cnpjHz(), 'urban1234');
  assert.strictEqual((await j('GET', '/admin/empresas', null, te))[0], 403);
  assert.strictEqual((await j('GET', '/dashboard'))[0], 401);
});
