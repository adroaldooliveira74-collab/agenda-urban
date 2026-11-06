'use strict';
/**
 * Integração somente-leitura com a API do eSocial Brasil.
 * Chave: variável ESOCIAL_TOKEN (Render) ou ~/.esocial/credenciais.env (máquina local).
 * A chave nunca é registrada em log nem devolvida pela API do sistema.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API = process.env.ESOCIAL_API_URL || 'https://app.esocialbrasil.com.br/api/v1';

function token() {
  if (process.env.ESOCIAL_TOKEN) return process.env.ESOCIAL_TOKEN.trim();
  if (process.env.NODE_ENV === 'test') return null;
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.esocial', 'credenciais.env'), 'utf8');
    const m = txt.match(/^\s*ESOCIAL_TOKEN\s*=\s*["']?([^"'\r\n]+)/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

const configurado = () => Boolean(token());

async function get(caminho) {
  const t = token();
  if (!t) return null;
  const r = await fetch(API + caminho, {
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(Number(process.env.ESOCIAL_TIMEOUT_MS || 8000)),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`eSocial Brasil respondeu ${r.status}`);
  const j = await r.json();
  return j && j.data !== undefined ? j.data : j;
}

const so = (s) => String(s || '').replace(/\D/g, '');

/** Empresa-cliente da consultoria pelo CNPJ. */
async function empresaPorCnpj(cnpj) {
  const d = await get(`/empresas?cnpj=${so(cnpj)}&per_page=5`);
  const lista = (d && d.data) || [];
  return lista.find((e) => so(e.cnpj) === so(cnpj)) || null;
}

/** Empregado pelo CPF dentro da empresa do eSocial. */
async function empregado(esEmpresaId, cpf) {
  return get(`/empresas/${esEmpresaId}/empregados/${so(cpf)}`);
}

/** Funções distintas dos empregados da empresa no eSocial. */
async function funcoesDaEmpresa(esEmpresaId, { maxPaginas = 20 } = {}) {
  const funcoes = new Map();
  for (let p = 1; p <= maxPaginas; p++) {
    const d = await get(`/empresas/${esEmpresaId}/empregados?per_page=100&page=${p}`);
    if (!d || !d.data) break;
    for (const e of d.data) {
      const f = String(e.funcao || '').trim();
      if (f && e.situacao !== 'desligado') funcoes.set(f.toUpperCase(), f);
    }
    if (!d.next_page_url) break;
  }
  return [...funcoes.values()].sort();
}

module.exports = { configurado, empresaPorCnpj, empregado, funcoesDaEmpresa };
