'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const { digits, fmtData, fmtMoeda } = require('./util');

const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const caminho = (rel) => path.join(require('./db').DATA_DIR, rel);

let transporter = null;
function smtp() {
  if (!process.env.SMTP_HOST) return null;
  if (!transporter) {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE) === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

function registrar({ canal, destino, assunto, mensagem, anexo, status, erro, referencia }) {
  db.prepare(
    'INSERT INTO notificacoes (canal, destino, assunto, mensagem, anexo, status, erro, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(canal, destino, assunto || null, mensagem, anexo || null, status, erro || null, referencia || null);
}

async function enviarEmail({ para, assunto, texto, anexo, referencia }) {
  if (!para) return 'ignorado';
  const t = smtp();
  if (!t) {
    registrar({ canal: 'email', destino: para, assunto, mensagem: texto, anexo, status: 'simulado', referencia });
    return 'simulado';
  }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: para,
      subject: assunto,
      text: texto,
      attachments: anexo ? [{ filename: path.basename(anexo), path: caminho(anexo) }] : [],
    });
    registrar({ canal: 'email', destino: para, assunto, mensagem: texto, anexo, status: 'enviado', referencia });
    return 'enviado';
  } catch (e) {
    registrar({ canal: 'email', destino: para, assunto, mensagem: texto, anexo, status: 'erro', erro: e.message, referencia });
    return 'erro';
  }
}

/** Normaliza telefone brasileiro para o formato 55DDDNUMERO. */
function telefoneWhats(tel) {
  const d = digits(tel);
  if (!d) return null;
  if (d.length === 10 || d.length === 11) return `55${d}`;
  return d;
}

async function enviarWhatsApp({ telefone, mensagem, anexo, referencia }) {
  const phone = telefoneWhats(telefone);
  if (!phone) return 'ignorado';
  if (!process.env.WHATSAPP_API_URL) {
    registrar({ canal: 'whatsapp', destino: phone, mensagem, anexo, status: 'simulado', referencia });
    return 'simulado';
  }
  try {
    const body = { phone, message: mensagem };
    if (anexo) {
      body.fileName = path.basename(anexo);
      body.fileBase64 = fs.readFileSync(caminho(anexo)).toString('base64');
    }
    const r = await fetch(process.env.WHATSAPP_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.WHATSAPP_API_TOKEN ? { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    registrar({ canal: 'whatsapp', destino: phone, mensagem, anexo, status: 'enviado', referencia });
    return 'enviado';
  } catch (e) {
    registrar({ canal: 'whatsapp', destino: phone, mensagem, anexo, status: 'erro', erro: e.message, referencia });
    return 'erro';
  }
}

/** Envia para vários destinatários, por e-mail e WhatsApp. */
async function enviarTodos(destinatarios, { assunto, texto, anexo, referencia }) {
  const tarefas = [];
  for (const d of destinatarios) {
    if (d.email) tarefas.push(enviarEmail({ para: d.email, assunto, texto: `Olá, ${d.nome}.\n\n${texto}`, anexo, referencia }));
    if (d.telefone) tarefas.push(enviarWhatsApp({ telefone: d.telefone, mensagem: `*${assunto}*\n\nOlá, ${d.nome}.\n${texto}`, anexo, referencia }));
  }
  return Promise.all(tarefas);
}

function destinatariosAgendamento(ag) {
  return [
    { nome: ag.responsavel, email: ag.empresa_email, telefone: ag.empresa_telefone },
    { nome: ag.func_nome, email: ag.func_email, telefone: ag.func_telefone },
    { nome: ag.clinica_nome, email: ag.clinica_email, telefone: ag.clinica_telefone },
  ];
}

function resumoAgendamento(ag) {
  return [
    `Exame: ${ag.tipo_nome}`,
    `Funcionário: ${ag.func_nome}`,
    `Empresa: ${ag.razao_social}`,
    `Data: ${fmtData(ag.data)} às ${ag.hora}`,
    `Clínica: ${ag.clinica_nome} — ${ag.clinica_endereco}, ${ag.clinica_cidade}/${ag.clinica_uf}`,
    `Código: ${ag.codigo}`,
    `Valor: ${fmtMoeda(ag.valor)} (PIX)`,
  ].join('\n');
}

const AVISO_PAGAMENTO =
  'IMPORTANTE: o comprovante de pagamento deverá ser enviado à clínica antes da realização do exame. ' +
  'O funcionário somente será atendido após a confirmação do pagamento.';

async function enviarGuia(ag, evento = 'novo') {
  const assunto = evento === 'reagendado' ? `Exame reagendado — ${ag.codigo}` : `Guia de encaminhamento — ${ag.codigo}`;
  const texto = `${evento === 'reagendado' ? 'O exame foi reagendado.' : 'Exame ocupacional agendado.'}\n\n${resumoAgendamento(ag)}\n\n${AVISO_PAGAMENTO}\n\nA guia de encaminhamento com o QR Code PIX segue em anexo.`;
  return enviarTodos(destinatariosAgendamento(ag), { assunto, texto, anexo: ag.guia_path, referencia: `agendamento:${ag.id}` });
}

async function enviarStatusPagamento(ag) {
  const rotulos = {
    comprovante_enviado: 'Comprovante de pagamento recebido. Aguardando confirmação da clínica.',
    pagamento_confirmado: 'Pagamento confirmado. O funcionário está liberado para o atendimento.',
    pagamento_recusado: `Pagamento recusado${ag.motivo_recusa ? `: ${ag.motivo_recusa}` : ''}. Envie um novo comprovante.`,
  };
  const texto = `${rotulos[ag.status_pagamento] || ag.status_pagamento}\n\n${resumoAgendamento(ag)}`;
  return enviarTodos(
    [{ nome: ag.responsavel, email: ag.empresa_email, telefone: ag.empresa_telefone }],
    { assunto: `Pagamento — ${ag.codigo}`, texto, referencia: `agendamento:${ag.id}` },
  );
}

async function enviarASO(aso) {
  const emp = db.prepare('SELECT * FROM empresas WHERE id = ?').get(aso.empresa_id);
  const f = db.prepare('SELECT * FROM funcionarios WHERE id = ?').get(aso.funcionario_id);
  const texto = `O ASO (${aso.tipo_nome}) de ${aso.func_nome} foi emitido${aso.hash_assinatura ? ' e assinado eletronicamente' : ''}.\nConclusão: ${aso.conclusao.replace(/_/g, ' ').toUpperCase()}\n${aso.data_validade ? `Validade: ${fmtData(aso.data_validade)}\n` : ''}\nO documento também está disponível em ${APP_URL()}`;
  return enviarTodos(
    [{ nome: emp.responsavel, email: emp.email, telefone: emp.telefone }, { nome: f.nome, email: f.email, telefone: f.telefone }],
    { assunto: `ASO disponível — ${aso.func_nome}`, texto, anexo: aso.arquivo, referencia: `aso:${aso.id}` },
  );
}

module.exports = { enviarEmail, enviarWhatsApp, enviarTodos, enviarGuia, enviarStatusPagamento, enviarASO, destinatariosAgendamento, resumoAgendamento, telefoneWhats };
