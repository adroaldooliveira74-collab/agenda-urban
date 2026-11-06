'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const httpError = (status, message) => new HttpError(status, message);

/** Envolve handlers async/sync para encaminhar erros ao middleware. */
const h = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) {
    next(e);
  }
};

const digits = (s) => String(s || '').replace(/\D/g, '');

function validaCPF(cpf) {
  const c = digits(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(c[i]) * (t + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[t])) return false;
  }
  return true;
}

function validaCNPJ(cnpj) {
  const c = digits(cnpj);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len) => {
    const pesos = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((acc, p, i) => acc + Number(c[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

const fmtCPF = (s) => digits(s).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
/** Documento da empresa: CNPJ (14 dígitos) ou CPF (11 dígitos, empregador pessoa física). */
const fmtCNPJ = (s) => (digits(s).length === 11
  ? digits(s).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4')
  : digits(s).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'));
const validaDocumento = (s) => (digits(s).length === 11 ? validaCPF(s) : validaCNPJ(s));
const fmtMoeda = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtData = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const pad = (n) => String(n).padStart(2, '0');
/** Data local no formato YYYY-MM-DD. */
const isoLocal = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = () => isoLocal(new Date());
const agoraISO = () => {
  const d = new Date();
  return `${isoLocal(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
function addDias(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoLocal(new Date(y, m - 1, d + n));
}
function addMeses(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  const ultimo = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
  dt.setDate(Math.min(d, ultimo));
  return isoLocal(dt);
}
function diasEntre(isoA, isoB) {
  const [a1, a2, a3] = isoA.split('-').map(Number);
  const [b1, b2, b3] = isoB.split('-').map(Number);
  return Math.round((Date.UTC(b1, b2 - 1, b3) - Date.UTC(a1, a2 - 1, a3)) / 86400000);
}
/** Date local a partir de 'YYYY-MM-DD' e 'HH:MM'. */
function dataHora(iso, hhmm) {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
}
const isISODate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function gerarCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (const b of bytes) s += alfabeto[b % alfabeto.length];
  return `UC-${hoje().slice(2).replace(/-/g, '')}-${s}`;
}

/** Garante que os campos existem e não estão vazios. */
function exigir(obj, campos, rotulos = {}) {
  const faltando = campos.filter((c) => obj[c] == null || String(obj[c]).trim() === '');
  if (faltando.length) {
    throw httpError(400, `Campos obrigatórios não informados: ${faltando.map((c) => rotulos[c] || c).join(', ')}`);
  }
}

/** Mantém apenas as chaves permitidas (evita atribuição em massa). */
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = {
  HttpError, httpError, h, digits, validaCPF, validaCNPJ, validaDocumento, fmtCPF, fmtCNPJ, fmtMoeda, fmtData,
  isoLocal, hoje, agoraISO, addDias, addMeses, diasEntre, dataHora, isISODate, gerarCodigo, exigir, pick,
};
