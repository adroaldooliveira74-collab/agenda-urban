'use strict';
/**
 * Dados iniciais: tipos de exame NR-7 e, opcionalmente, dados de demonstração
 * (todos fictícios). Executado automaticamente quando o banco está vazio.
 */
require('dotenv').config();
const { db, tx, setConfig } = require('./db');
const { hashSenha } = require('./auth');
const { hoje, addDias, addMeses, gerarCodigo } = require('./util');

const TIPOS = [
  ['admissional', 'Admissional', 'Realizado antes que o empregado assuma suas atividades.', 120, 12],
  ['periodico', 'Periódico', 'Conforme periodicidade definida no PCMSO (em regra anual).', 100, 12],
  ['mudanca_funcao', 'Mudança de Função', 'Antes da mudança de risco ocupacional do empregado.', 110, 12],
  ['retorno_trabalho', 'Retorno ao Trabalho', 'No primeiro dia de retorno após afastamento ≥ 30 dias por doença ou acidente.', 110, 12],
  ['demissional', 'Demissional', 'Até 10 dias após o término do contrato.', 100, null],
];

const COMPLEMENTARES = [
  ['audiometria', 'Audiometria', 60], ['acuidade_visual', 'Acuidade Visual', 30], ['espirometria', 'Espirometria', 70],
  ['hemograma', 'Hemograma Completo', 25], ['eletrocardiograma', 'Eletrocardiograma', 60], ['raio_x_torax', 'Raio-X de Tórax', 80],
];

function semearTipos() {
  const ins = db.prepare(
    `INSERT INTO tipos_exame (codigo, nome, categoria, descricao, valor_padrao, validade_meses) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(codigo) DO NOTHING`,
  );
  for (const [c, n, d, v, m] of TIPOS) ins.run(c, n, 'ocupacional', d, v, m);
  for (const [c, n, v] of COMPLEMENTARES) ins.run(c, n, 'complementar', null, v, null);
}

/* Geradores de documentos fictícios válidos */
function cpfValido(base9) {
  const n = String(base9).padStart(9, '0').split('').map(Number);
  for (const t of [9, 10]) {
    let s = 0;
    for (let i = 0; i < t; i++) s += n[i] * (t + 1 - i);
    n.push(((s * 10) % 11) % 10);
  }
  return n.join('');
}
function cnpjValido(base12) {
  const n = String(base12).padStart(12, '0').split('').map(Number);
  for (const pesos of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const r = pesos.reduce((a, p, i) => a + n[i] * p, 0) % 11;
    n.push(r < 2 ? 0 : 11 - r);
  }
  return n.join('');
}

function semearDemo() {
  setConfig('pix_chave', 'financeiro@urbanclin.com.br');
  setConfig('pix_nome', 'URBANCLIN MEDICINA');
  setConfig('pix_cidade', 'SAO PAULO');
  setConfig('whatsapp_financeiro', '(11) 99999-0000');
  setConfig('email_financeiro', 'financeiro@urbanclin.com.br');

  const cl1 = Number(db.prepare(
    `INSERT INTO clinicas (nome, cnpj, endereco, bairro, cidade, uf, cep, telefone, email, whatsapp_financeiro, email_financeiro, pix_chave, pix_nome, pix_cidade, hora_inicio, hora_fim, intervalo_min, capacidade_horario)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('UrbanClin — Unidade Centro', cnpjValido('112223330001'), 'Av. Paulista, 1000 - Sala 101', 'Bela Vista', 'São Paulo', 'SP', '01310-100',
    '(11) 3333-1000', 'centro@urbanclin.com.br', '(11) 99999-1000', 'financeiro.centro@urbanclin.com.br', 'financeiro@urbanclin.com.br',
    'URBANCLIN CENTRO', 'SAO PAULO', '07:00', '17:00', 20, 2).lastInsertRowid);
  const cl2 = Number(db.prepare(
    `INSERT INTO clinicas (nome, cnpj, endereco, bairro, cidade, uf, cep, telefone, email, whatsapp_financeiro, email_financeiro, hora_inicio, hora_fim, intervalo_min, capacidade_horario, dias_semana)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('UrbanClin — Unidade Zona Sul', cnpjValido('112223330002'), 'Rua Vergueiro, 5000', 'Ipiranga', 'São Paulo', 'SP', '04273-100',
    '(11) 3333-2000', 'zonasul@urbanclin.com.br', '(11) 99999-2000', 'financeiro.sul@urbanclin.com.br', '08:00', '16:00', 30, 1, '1,2,3,4,5,6').lastInsertRowid);

  const tipos = Object.fromEntries(db.prepare('SELECT codigo, id FROM tipos_exame').all().map((t) => [t.codigo, t.id]));
  db.prepare('INSERT INTO precos (clinica_id, tipo_exame_id, valor) VALUES (?, ?, ?)').run(cl2, tipos.periodico, 90);

  const m1 = Number(db.prepare('INSERT INTO medicos (nome, crm, uf_crm, clinica_id, email, telefone) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Dra. Helena Martins', '123456', 'SP', cl1, 'helena@urbanclin.com.br', '(11) 98888-1000').lastInsertRowid);
  db.prepare('INSERT INTO medicos (nome, crm, uf_crm, clinica_id, email, telefone) VALUES (?, ?, ?, ?, ?, ?)')
    .run('Dr. Ricardo Alves', '654321', 'SP', cl2, 'ricardo@urbanclin.com.br', '(11) 98888-2000');

  const e1 = Number(db.prepare('INSERT INTO empresas (cnpj, razao_social, responsavel, telefone, email) VALUES (?, ?, ?, ?, ?)')
    .run(cnpjValido('445556660001'), 'Construtora Horizonte Ltda', 'Marcos Pereira', '(11) 97777-1000', 'rh@horizonte.com.br').lastInsertRowid);
  const e2 = Number(db.prepare('INSERT INTO empresas (cnpj, razao_social, responsavel, telefone, email) VALUES (?, ?, ?, ?, ?)')
    .run(cnpjValido('778889990001'), 'Logística Rápida S.A.', 'Juliana Costa', '(11) 97777-2000', 'sesmt@lograpida.com.br').lastInsertRowid);

  const usuario = db.prepare('INSERT INTO usuarios (nome, email, senha_hash, perfil, empresa_id, clinica_id, medico_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  usuario.run('Administrador', 'admin@urbanclin.com.br', hashSenha('admin123'), 'admin', null, null, null);
  usuario.run('Recepção Centro', 'clinica@urbanclin.com.br', hashSenha('clinica123'), 'clinica', null, cl1, null);
  usuario.run('Dra. Helena Martins', 'medico@urbanclin.com.br', hashSenha('medico123'), 'medico', null, cl1, m1);
  usuario.run('Marcos Pereira', 'empresa@horizonte.com.br', hashSenha('empresa123'), 'empresa', e1, null, null);
  usuario.run('Juliana Costa', 'empresa@lograpida.com.br', hashSenha('empresa123'), 'empresa', e2, null, null);

  // Riscos por função (PGR) de demonstração; funções sem cadastro saem em branco
  const { salvarRiscoFuncao } = require('./services');
  salvarRiscoFuncao(e1, { funcao: 'Pedreiro', fisicos: 'Ruído; Radiação não ionizante (exposição solar)', quimicos: 'Poeira de cimento; Sílica', ergonomicos: 'Levantamento e transporte manual de peso; Postura inadequada', acidentes: 'Queda de altura; Queda de materiais' });
  salvarRiscoFuncao(e1, { funcao: 'Eletricista', acidentes: 'Choque elétrico; Queda de altura', ergonomicos: 'Postura inadequada' });
  salvarRiscoFuncao(e2, { funcao: 'Motorista', fisicos: 'Vibração de corpo inteiro; Ruído', ergonomicos: 'Postura sentada por longos períodos; Jornada prolongada', acidentes: 'Acidente de trânsito' });

  const pessoas = [
    [e1, 'Carlos Eduardo Silva', 'Pedreiro', '1980-04-12'], [e1, 'Ana Paula Souza', 'Engenheira Civil', '1990-09-03'],
    [e1, 'José Ribeiro Santos', 'Eletricista', '1985-01-22'], [e1, 'Fernanda Lima', 'Técnica de Segurança', '1993-06-15'],
    [e2, 'Rafael Oliveira', 'Motorista', '1978-11-30'], [e2, 'Patrícia Gomes', 'Auxiliar de Logística', '1995-02-08'],
    [e2, 'Bruno Carvalho', 'Operador de Empilhadeira', '1988-07-19'],
  ];
  const insF = db.prepare('INSERT INTO funcionarios (empresa_id, nome, rg, cpf, telefone, email, data_nascimento, funcao, data_admissao) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const funcs = pessoas.map(([emp, nome, funcao, nasc], i) => ({
    id: Number(insF.run(emp, nome, `${30 + i}.456.789-${i}`, cpfValido(String(123456780 + i * 7)), `(11) 96666-10${String(i).padStart(2, '0')}`,
      null, nasc, funcao, addMeses(hoje(), -14 - i)).lastInsertRowid),
    emp, nome, funcao,
  }));

  // Histórico: ASOs anteriores com validades variadas (para alertas e vencimentos)
  const insAg = db.prepare(
    `INSERT INTO agendamentos (codigo, empresa_id, funcionario_id, clinica_id, medico_id, tipo_exame_id, funcao_atual, data, hora, valor, status, status_pagamento, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insAso = db.prepare(
    `INSERT INTO asos (agendamento_id, funcionario_id, empresa_id, medico_id, tipo_exame_id, funcao, riscos, exames_realizados, conclusao, data_emissao, data_validade)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'apto', ?, ?)`,
  );
  const insHist = db.prepare('INSERT INTO historico_funcional (funcionario_id, evento, descricao, agendamento_id, data) VALUES (?, ?, ?, ?, ?)');
  const deslocamentoValidade = [-10, 12, 25, 50, 80, 200, 300]; // dias até vencer
  funcs.forEach((f, i) => {
    const validade = addDias(hoje(), deslocamentoValidade[i]);
    const emissao = addMeses(validade, -12);
    const agId = Number(insAg.run(gerarCodigo(), f.emp, f.id, cl1, m1, tipos.admissional, f.funcao, emissao, '08:00', 120, 'realizado', 'pagamento_confirmado', `${emissao} 08:00:00`).lastInsertRowid);
    insAso.run(agId, f.id, f.emp, m1, tipos.admissional, f.funcao, 'Conforme PGR da empresa', 'Exame clínico; Acuidade Visual', emissao, validade);
    insHist.run(f.id, 'admissao', `Admissão na função ${f.funcao}`, agId, emissao);
    insHist.run(f.id, 'aso_emitido', 'ASO Admissional — apto', agId, emissao);
  });

  // Movimento dos últimos meses (para gráficos e faturamento)
  for (let d = 1; d <= 150; d += 3) {
    const f = funcs[d % funcs.length];
    const data = addDias(hoje(), -d);
    const status = d % 11 === 0 ? 'ausente' : d % 13 === 0 ? 'cancelado' : 'realizado';
    const pg = status === 'realizado' ? 'pagamento_confirmado' : 'aguardando_pagamento';
    insAg.run(gerarCodigo(), f.emp, f.id, d % 2 ? cl1 : cl2, m1, d % 3 ? tipos.periodico : tipos.mudanca_funcao, f.funcao, data,
      `${String(8 + (d % 8)).padStart(2, '0')}:00`, d % 3 ? 100 : 110, status, pg, `${data} 09:00:00`);
  }
}

function seed({ demo = true } = {}) {
  return tx(() => {
    semearTipos();
    const temUsuarios = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n > 0;
    if (temUsuarios) return false;
    if (demo) semearDemo();
    else {
      db.prepare("INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES ('Administrador', ?, ?, 'admin')")
        .run(process.env.ADMIN_EMAIL || 'admin@urbanclin.com.br', hashSenha(process.env.ADMIN_SENHA || 'admin123'));
    }
    return true;
  });
}

module.exports = { seed, cpfValido, cnpjValido };

if (require.main === module) {
  const criado = seed({ demo: process.env.SEED_DEMO !== 'false' });
  console.log(criado ? 'Banco populado com dados iniciais.' : 'Banco já possui usuários; nada foi alterado.');
}
