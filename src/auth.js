'use strict';
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { httpError } = require('./util');

const SECRET = process.env.JWT_SECRET || 'urban-clin-dev-secret-troque-em-producao';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.warn('[auth] ATENÇÃO: defina JWT_SECRET no ambiente de produção.');
}

const hashSenha = (s) => bcrypt.hashSync(String(s), 10);
const confereSenha = (s, hash) => bcrypt.compareSync(String(s), hash);

function emitirToken(u) {
  return jwt.sign(
    { id: u.id, perfil: u.perfil, empresa_id: u.empresa_id, clinica_id: u.clinica_id, medico_id: u.medico_id },
    SECRET,
    { expiresIn: '12h' },
  );
}

/** Middleware: exige token válido e carrega req.user. */
function autenticar(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(httpError(401, 'Não autenticado'));
  try {
    const payload = jwt.verify(token, SECRET);
    const u = db
      .prepare('SELECT id, nome, email, login, perfil, empresa_id, clinica_id, medico_id, ativo, trocar_senha FROM usuarios WHERE id = ?')
      .get(payload.id);
    if (!u || !u.ativo) return next(httpError(401, 'Usuário inativo ou inexistente'));
    req.user = u;
    // Primeiro acesso: só é possível ver o próprio cadastro e trocar a senha inicial
    const livre = /^\/api\/auth\/(me|senha)(\?|$)/.test(req.originalUrl);
    if (u.trocar_senha && !livre) return next(httpError(403, 'Troque a senha inicial para continuar'));
    next();
  } catch {
    next(httpError(401, 'Sessão expirada. Entre novamente.'));
  }
}

/** Middleware: restringe a rota aos perfis informados. */
const perfil = (...perfis) => (req, _res, next) => {
  if (!req.user || !perfis.includes(req.user.perfil)) return next(httpError(403, 'Acesso não permitido para este perfil'));
  next();
};

module.exports = { hashSenha, confereSenha, emitirToken, autenticar, perfil };
