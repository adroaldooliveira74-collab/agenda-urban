'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DOCS_DIR = path.join(DATA_DIR, 'documentos');
for (const d of [DATA_DIR, UPLOAD_DIR, DOCS_DIR]) fs.mkdirSync(d, { recursive: true });

const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'urban.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS empresas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cnpj TEXT NOT NULL UNIQUE,
  razao_social TEXT NOT NULL,
  responsavel TEXT NOT NULL,
  telefone TEXT NOT NULL,
  email TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS clinicas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  cnpj TEXT,
  endereco TEXT NOT NULL,
  bairro TEXT,
  cidade TEXT NOT NULL,
  uf TEXT NOT NULL,
  cep TEXT,
  telefone TEXT NOT NULL,
  email TEXT,
  whatsapp_financeiro TEXT,
  email_financeiro TEXT,
  maps_url TEXT,
  pix_chave TEXT,
  pix_nome TEXT,
  pix_cidade TEXT,
  hora_inicio TEXT NOT NULL DEFAULT '07:00',
  hora_fim TEXT NOT NULL DEFAULT '17:00',
  intervalo_min INTEGER NOT NULL DEFAULT 20,
  capacidade_horario INTEGER NOT NULL DEFAULT 1,
  dias_semana TEXT NOT NULL DEFAULT '1,2,3,4,5',
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS medicos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  crm TEXT NOT NULL,
  uf_crm TEXT NOT NULL,
  clinica_id INTEGER REFERENCES clinicas(id),
  email TEXT,
  telefone TEXT,
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','clinica','empresa','medico')),
  empresa_id INTEGER REFERENCES empresas(id),
  clinica_id INTEGER REFERENCES clinicas(id),
  medico_id INTEGER REFERENCES medicos(id),
  ativo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Tipos de exame ocupacional (NR-7) e exames complementares
CREATE TABLE IF NOT EXISTS tipos_exame (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'ocupacional' CHECK (categoria IN ('ocupacional','complementar')),
  descricao TEXT,
  valor_padrao REAL NOT NULL DEFAULT 0,
  validade_meses INTEGER,
  ativo INTEGER NOT NULL DEFAULT 1
);

-- Valor do exame por clínica (sobrepõe o valor padrão)
CREATE TABLE IF NOT EXISTS precos (
  clinica_id INTEGER NOT NULL REFERENCES clinicas(id),
  tipo_exame_id INTEGER NOT NULL REFERENCES tipos_exame(id),
  valor REAL NOT NULL,
  PRIMARY KEY (clinica_id, tipo_exame_id)
);

CREATE TABLE IF NOT EXISTS funcionarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome TEXT NOT NULL,
  rg TEXT NOT NULL,
  cpf TEXT NOT NULL,
  telefone TEXT NOT NULL,
  email TEXT,
  data_nascimento TEXT NOT NULL,
  funcao TEXT NOT NULL,
  situacao TEXT NOT NULL DEFAULT 'ativo' CHECK (situacao IN ('ativo','afastado','demitido')),
  data_admissao TEXT,
  data_demissao TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (empresa_id, cpf)
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  funcionario_id INTEGER NOT NULL REFERENCES funcionarios(id),
  clinica_id INTEGER NOT NULL REFERENCES clinicas(id),
  medico_id INTEGER REFERENCES medicos(id),
  tipo_exame_id INTEGER NOT NULL REFERENCES tipos_exame(id),
  funcao_atual TEXT,
  funcao_nova TEXT,
  data TEXT NOT NULL,
  hora TEXT NOT NULL,
  valor REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado','compareceu','em_atendimento','realizado','ausente','cancelado')),
  status_pagamento TEXT NOT NULL DEFAULT 'aguardando_pagamento'
    CHECK (status_pagamento IN ('aguardando_pagamento','comprovante_enviado','pagamento_confirmado','pagamento_recusado')),
  motivo_recusa TEXT,
  pix_payload TEXT,
  observacoes_empresa TEXT,
  observacoes_medico TEXT,
  guia_path TEXT,
  created_by INTEGER REFERENCES usuarios(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ag_data ON agendamentos(data, clinica_id);
CREATE INDEX IF NOT EXISTS idx_ag_func ON agendamentos(funcionario_id);

CREATE TABLE IF NOT EXISTS resultados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id),
  exame TEXT NOT NULL,
  resultado TEXT,
  observacao TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER REFERENCES agendamentos(id),
  funcionario_id INTEGER REFERENCES funcionarios(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('guia','aso','laudo','comprovante','outro')),
  nome TEXT NOT NULL,
  arquivo TEXT NOT NULL,
  mime TEXT,
  enviado_por INTEGER REFERENCES usuarios(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS asos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agendamento_id INTEGER NOT NULL UNIQUE REFERENCES agendamentos(id),
  funcionario_id INTEGER NOT NULL REFERENCES funcionarios(id),
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  medico_id INTEGER REFERENCES medicos(id),
  tipo_exame_id INTEGER NOT NULL REFERENCES tipos_exame(id),
  funcao TEXT NOT NULL,
  riscos TEXT,
  exames_realizados TEXT,
  conclusao TEXT NOT NULL CHECK (conclusao IN ('apto','inapto','apto_com_restricao')),
  restricoes TEXT,
  observacoes TEXT,
  data_emissao TEXT NOT NULL,
  data_validade TEXT,
  hash_assinatura TEXT,
  assinado_por INTEGER REFERENCES medicos(id),
  assinado_em TEXT,
  arquivo TEXT,
  emitido_por INTEGER REFERENCES usuarios(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Histórico ocupacional do funcionário (PCMSO)
CREATE TABLE IF NOT EXISTS historico_funcional (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  funcionario_id INTEGER NOT NULL REFERENCES funcionarios(id),
  evento TEXT NOT NULL CHECK (evento IN ('admissao','periodico','mudanca_funcao','retorno_trabalho','demissao','aso_emitido','exame_realizado')),
  descricao TEXT,
  funcao_anterior TEXT,
  funcao_nova TEXT,
  agendamento_id INTEGER REFERENCES agendamentos(id),
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS notificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canal TEXT NOT NULL CHECK (canal IN ('email','whatsapp')),
  destino TEXT NOT NULL,
  assunto TEXT,
  mensagem TEXT NOT NULL,
  anexo TEXT,
  status TEXT NOT NULL CHECK (status IN ('enviado','simulado','erro')),
  erro TEXT,
  referencia TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notif_ref ON notificacoes(referencia);

CREATE TABLE IF NOT EXISTS alertas_enviados (
  chave TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

/** Executa fn dentro de uma transação. */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getConfig(chave, padrao = null) {
  const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
  return r ? r.valor : padrao;
}
function setConfig(chave, valor) {
  db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(chave, valor == null ? null : String(valor));
}

module.exports = { db, tx, getConfig, setConfig, DATA_DIR, UPLOAD_DIR, DOCS_DIR };
