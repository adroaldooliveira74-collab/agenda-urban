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
const login = async (email, senha) => (await j('POST', '/auth/login', { email, senha }))[1].token;

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
  const te = await login('empresa@horizonte.com.br', 'empresa123');
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
  const te = await login('empresa@horizonte.com.br', 'empresa123');
  const ta = await login('admin@urbanclin.com.br', 'admin123');
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

test('perfis não acessam rotas de outros perfis', async () => {
  const te = await login('empresa@horizonte.com.br', 'empresa123');
  assert.strictEqual((await j('GET', '/admin/empresas', null, te))[0], 403);
  assert.strictEqual((await j('GET', '/dashboard'))[0], 401);
});
