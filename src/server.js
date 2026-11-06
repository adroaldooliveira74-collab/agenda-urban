'use strict';
require('dotenv').config();
const path = require('node:path');
const express = require('express');
const { seed, garantirAcessos } = require('./seed');

seed({ demo: process.env.SEED_DEMO !== 'false' });
garantirAcessos();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));
app.use('/api', (_req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let msg = err.message;
  if (err.code === 'LIMIT_FILE_SIZE') { status = 400; msg = 'Arquivo maior que 10 MB'; }
  else if (/UNIQUE constraint/.test(err.message || '')) { status = 409; msg = 'Registro duplicado'; }
  else if (/CHECK constraint/.test(err.message || '')) { status = 400; msg = 'Valor inválido'; }
  else if (status >= 500) { console.error(err); msg = 'Erro interno no servidor'; }
  res.status(status).json({ erro: msg });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`UrbanClin rodando em http://localhost:${port}`);
    require('./scheduler').iniciar();
  });
}

module.exports = app;
