'use strict';
const { db } = require('./db');
const { hoje, diasEntre, dataHora, fmtData } = require('./util');
const notify = require('./notify');
const { AG_SELECT, vencimentos } = require('./services');

const DIAS_VENCIMENTO = [90, 60, 30, 15];
const HORAS_LEMBRETE = [72, 24, 2];

/** Marca o alerta como enviado; retorna false se já tinha sido enviado. */
function marcar(chave) {
  const r = db.prepare('INSERT OR IGNORE INTO alertas_enviados (chave) VALUES (?)').run(chave);
  return r.changes > 0;
}

/**
 * Vencimento de exames: avisa empresa e funcionário quando faltam 90, 60, 30 e 15 dias.
 * Se a rotina ficar parada, envia o marco mais próximo ainda não enviado (sem repetir os anteriores).
 */
async function alertasVencimento() {
  let enviados = 0;
  const h = hoje();
  for (const v of vencimentos()) {
    if (!v.data_validade) continue;
    const dias = diasEntre(h, v.data_validade);
    if (dias < 0 || dias > 90) continue;
    const marco = [...DIAS_VENCIMENTO].reverse().find((d) => dias <= d);
    if (!marco) continue;
    if (!marcar(`vencimento:${v.aso_id}:${marco}`)) continue;
    // marcos maiores, já ultrapassados, não devem ser enviados depois
    for (const d of DIAS_VENCIMENTO.filter((d) => d > marco)) marcar(`vencimento:${v.aso_id}:${d}`);
    const emp = db.prepare('SELECT * FROM empresas WHERE id = ?').get(v.empresa_id);
    const texto =
      `O exame ocupacional de ${v.nome} (${v.funcao}) vence em ${dias} dia(s), em ${fmtData(v.data_validade)}.\n` +
      (v.proximo_agendamento ? `Já existe agendamento: ${v.proximo_agendamento}.` : 'Agende o exame periódico para manter o PCMSO em dia.');
    await notify.enviarTodos(
      [{ nome: emp.responsavel, email: emp.email, telefone: emp.telefone }, { nome: v.nome, email: v.email, telefone: v.telefone }],
      { assunto: `Vencimento de exame em ${dias} dias — ${v.nome}`, texto, referencia: `vencimento:${v.aso_id}` },
    );
    enviados++;
  }
  return enviados;
}

/** Lembretes de agendamento: 72h, 24h e 2h antes. */
async function lembretesAgendamento(agora = new Date()) {
  let enviados = 0;
  const ate = new Date(agora.getTime() + 73 * 3600 * 1000);
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ags = db.prepare(`${AG_SELECT} WHERE a.status = 'agendado' AND a.data BETWEEN ? AND ?`).all(iso(agora), iso(ate));
  for (const ag of ags) {
    const horas = (dataHora(ag.data, ag.hora) - agora) / 3600000;
    if (horas <= 0) continue;
    const marco = [...HORAS_LEMBRETE].reverse().find((x) => horas <= x);
    if (!marco) continue;
    if (!marcar(`lembrete:${ag.id}:${marco}`)) continue;
    for (const x of HORAS_LEMBRETE.filter((x) => x > marco)) marcar(`lembrete:${ag.id}:${x}`);
    const pagamento =
      ag.status_pagamento === 'pagamento_confirmado'
        ? 'Pagamento confirmado.'
        : 'ATENÇÃO: pagamento ainda não confirmado. Envie o comprovante à clínica antes do exame.';
    const texto = `Lembrete: exame em ${marco === 2 ? 'cerca de 2 horas' : `${marco} horas`}.\n\n${notify.resumoAgendamento(ag)}\n\n${pagamento}`;
    await notify.enviarTodos(notify.destinatariosAgendamento(ag), {
      assunto: `Lembrete de exame — ${fmtData(ag.data)} ${ag.hora}`, texto, referencia: `agendamento:${ag.id}`,
    });
    enviados++;
  }
  return enviados;
}

/** Marca como ausentes os agendamentos de dias anteriores sem comparecimento. */
function marcarAusentes() {
  return db.prepare(`UPDATE agendamentos SET status = 'ausente' WHERE status = 'agendado' AND data < date('now','localtime')`).run().changes;
}

async function rodar() {
  try {
    const ausentes = marcarAusentes();
    const venc = await alertasVencimento();
    const lemb = await lembretesAgendamento();
    if (venc || lemb || ausentes) console.log(`[alertas] vencimentos: ${venc}, lembretes: ${lemb}, ausentes: ${ausentes}`);
    return { vencimentos: venc, lembretes: lemb, ausentes };
  } catch (e) {
    console.error('[alertas] erro:', e);
    return { erro: e.message };
  }
}

function iniciar() {
  const minutos = Number(process.env.ALERTAS_INTERVALO_MIN || 15);
  setTimeout(rodar, 5000).unref();
  setInterval(rodar, minutos * 60 * 1000).unref();
  console.log(`[alertas] rotina automática a cada ${minutos} min`);
}

module.exports = { iniciar, rodar, alertasVencimento, lembretesAgendamento, marcarAusentes };
