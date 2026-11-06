'use strict';
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { DATA_DIR, DOCS_DIR } = require('./db');
const { fmtCPF, fmtCNPJ, fmtMoeda, fmtData } = require('./util');

// Cores da marca UrbanClin
const AZUL = '#009640'; // verde principal (títulos e seções)
const LARANJA = '#f39200';
const LIMAO = '#95c11f';
const CINZA = '#555555';
const LOGO = path.join(__dirname, '..', 'public', 'img', 'logo.png');
const temLogo = fs.existsSync(LOGO);
const VERMELHO = '#c62828';
const APP_URL = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/$/, '');

function novoDoc(titulo) {
  return new PDFDocument({ size: 'A4', margin: 40, info: { Title: titulo, Author: 'UrbanClin' } });
}

function salvar(doc, nomeArquivo) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => {
      const rel = path.join('documentos', nomeArquivo);
      fs.writeFileSync(path.join(DOCS_DIR, nomeArquivo), Buffer.concat(chunks));
      resolve(rel.replace(/\\/g, '/'));
    });
    doc.end();
  });
}

/** Caminho absoluto de um arquivo salvo (relativo a DATA_DIR). */
const caminhoArquivo = (rel) => path.join(DATA_DIR, rel);

function cabecalho(doc, titulo, subtitulo) {
  if (temLogo) doc.image(LOGO, 40, 14, { height: 56 });
  else doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(20).text('UrbanClin', 40, 24);
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(14).text(titulo, 240, 26, { width: doc.page.width - 280, align: 'right' });
  if (subtitulo) doc.fillColor(CINZA).font('Helvetica').fontSize(9).text(subtitulo, 240, 46, { width: doc.page.width - 280, align: 'right' });
  // faixa nas cores da marca
  const w = doc.page.width;
  doc.rect(0, 78, w * 0.5, 4).fill(LARANJA);
  doc.rect(w * 0.5, 78, w * 0.25, 4).fill(LIMAO);
  doc.rect(w * 0.75, 78, w * 0.25, 4).fill(AZUL);
  doc.fillColor('#000000');
  doc.y = 92;
}

function secao(doc, titulo) {
  doc.moveDown(0.6);
  const y = doc.y;
  doc.rect(40, y, doc.page.width - 80, 18).fill('#eaf5e6');
  doc.rect(40, y, 3, 18).fill(LARANJA);
  doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(10).text(titulo.toUpperCase(), 46, y + 5);
  doc.fillColor('#000000');
  doc.y = y + 24;
}

/** Linhas "Rótulo: valor" em duas colunas. */
function campos(doc, pares) {
  const largura = (doc.page.width - 80) / 2;
  for (let i = 0; i < pares.length; i += 2) {
    const y = doc.y;
    let maxY = y;
    for (let j = 0; j < 2; j++) {
      const par = pares[i + j];
      if (!par) continue;
      const x = 46 + j * largura;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(CINZA).text(par[0], x, y, { width: largura - 12 });
      doc.font('Helvetica').fontSize(10).fillColor('#000000').text(par[1] == null || par[1] === '' ? '—' : String(par[1]), x, doc.y, { width: largura - 12 });
      maxY = Math.max(maxY, doc.y);
    }
    doc.y = maxY + 4;
  }
  doc.x = 40;
}

/* ------------------------------------------------------------------ */
/* Guia de encaminhamento                                               */
/* ------------------------------------------------------------------ */

async function gerarGuia(ag, { fin, maps }) {
  const doc = novoDoc(`Guia de Encaminhamento ${ag.codigo}`);
  cabecalho(doc, 'GUIA DE ENCAMINHAMENTO', `Código ${ag.codigo}`);

  secao(doc, 'Dados da Empresa');
  campos(doc, [
    ['Razão Social', ag.razao_social], ['CNPJ', fmtCNPJ(ag.cnpj)],
    ['Responsável', ag.responsavel], ['Telefone', ag.empresa_telefone],
  ]);

  secao(doc, 'Dados do Funcionário');
  campos(doc, [
    ['Nome', ag.func_nome], ['CPF', fmtCPF(ag.func_cpf)],
    ['RG', ag.func_rg], ['Data de Nascimento', fmtData(ag.func_nascimento)],
    ['Função', ag.funcao_nova ? `${ag.funcao_atual} → ${ag.funcao_nova}` : ag.func_funcao],
  ]);

  secao(doc, 'Dados do Exame');
  campos(doc, [
    ['Tipo do Exame (NR-7)', ag.tipo_nome], ['Código do Agendamento', ag.codigo],
    ['Data', fmtData(ag.data)], ['Horário', ag.hora],
  ]);

  secao(doc, 'Riscos Ocupacionais da Função');
  blocoRiscos(doc, ag.riscos);

  secao(doc, 'Dados da Clínica');
  campos(doc, [
    ['Nome da Clínica', ag.clinica_nome], ['Telefone', ag.clinica_telefone],
    ['Endereço Completo', [ag.clinica_endereco, ag.clinica_bairro, ag.clinica_cep && `CEP ${ag.clinica_cep}`].filter(Boolean).join(' — ')],
    ['Cidade', `${ag.clinica_cidade}/${ag.clinica_uf}`],
  ]);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(CINZA).text('Google Maps', 46);
  doc.font('Helvetica').fontSize(9).fillColor('#1a5fb4').text(maps, 46, doc.y, { link: maps, underline: true, width: doc.page.width - 92 });
  doc.fillColor('#000000');

  secao(doc, 'Informações de Pagamento');
  const yPag = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(CINZA).text('Valor do Exame', 46, yPag);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#000000').text(fmtMoeda(ag.valor), 46, doc.y);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(CINZA).text('PIX — Chave PIX', 46);
  doc.font('Helvetica').fontSize(10).fillColor('#000000').text(fin.pix_chave || 'Chave PIX não configurada — consulte a clínica', 46, doc.y, { width: 300 });
  if (fin.pix_nome) doc.fontSize(8).fillColor(CINZA).text(`Favorecido: ${fin.pix_nome}`, 46, doc.y, { width: 300 });
  if (ag.pix_payload) {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(CINZA).text('PIX Copia e Cola', 46);
    doc.font('Courier').fontSize(6.5).fillColor('#000000').text(ag.pix_payload, 46, doc.y, { width: 330 });
    const qr = await QRCode.toBuffer(ag.pix_payload, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
    doc.image(qr, doc.page.width - 40 - 130, yPag, { width: 130 });
    doc.font('Helvetica').fontSize(7).fillColor(CINZA).text('QR Code PIX', doc.page.width - 40 - 130, yPag + 132, { width: 130, align: 'center' });
    doc.y = Math.max(doc.y, yPag + 145);
  }
  doc.fillColor('#000000');

  // Aviso obrigatório em vermelho
  doc.moveDown(0.8);
  const yAviso = doc.y;
  const largura = doc.page.width - 80;
  const linhas = [
    'O comprovante de pagamento deverá ser enviado à clínica antes da realização do exame.',
    'O funcionário somente será atendido após a confirmação do pagamento.',
  ];
  const altura = 118;
  if (yAviso + altura > doc.page.height - 50) doc.addPage();
  const y0 = doc.y;
  doc.lineWidth(2).rect(40, y0, largura, altura).fillAndStroke('#fdecea', VERMELHO);
  doc.fillColor(VERMELHO).font('Helvetica-Bold').fontSize(14).text('IMPORTANTE', 52, y0 + 10, { width: largura - 24 });
  doc.font('Helvetica-Bold').fontSize(10);
  for (const l of linhas) doc.text(l, 52, doc.y + 3, { width: largura - 24 });
  doc.moveDown(0.4).text('Envie o comprovante para:', 52, doc.y, { width: largura - 24 });
  doc.text(`WhatsApp: ${fin.whatsapp || '—'}`, 52, doc.y, { width: largura - 24 });
  doc.text(`E-mail: ${fin.email || '—'}`, 52, doc.y, { width: largura - 24 });
  doc.fillColor('#000000').lineWidth(1);
  doc.y = y0 + altura + 10;

  doc.font('Helvetica').fontSize(7.5).fillColor(CINZA)
    .text(`Documento gerado em ${new Date().toLocaleString('pt-BR')} · UrbanClin. Apresente esta guia e um documento com foto no dia do exame.`, 40, doc.y, { align: 'center', width: largura });

  return salvar(doc, `guia-${ag.codigo}.pdf`);
}

/* ------------------------------------------------------------------ */
/* ASO — Atestado de Saúde Ocupacional                                  */
/* ------------------------------------------------------------------ */

const TIPOS_ASO = [
  ['admissional', 'Admissional'], ['periodico', 'Periódico'], ['retorno_trabalho', 'Retorno ao Trabalho'],
  ['mudanca_funcao', 'Mudança de Função'], ['demissional', 'Demissional'],
];
const CONCLUSOES = [['apto', 'APTO'], ['apto_com_restricao', 'APTO COM RESTRIÇÃO'], ['inapto', 'INAPTO']];

/** Riscos cadastrados (uma categoria por linha) ou linhas em branco para preenchimento. */
function blocoRiscos(doc, texto) {
  const largura = doc.page.width - 92;
  if (String(texto || '').trim()) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#000000').text(String(texto).trim(), 46, doc.y, { width: largura, lineGap: 1 });
    return;
  }
  doc.moveDown(0.6);
  for (let i = 0; i < 2; i++) {
    const y = doc.y + 10;
    doc.lineWidth(0.5).moveTo(46, y).lineTo(46 + largura, y).stroke('#9a9a9a');
    doc.y = y + 4;
  }
  doc.lineWidth(1).fillColor('#000000');
  doc.x = 40;
}

function caixas(doc, opcoes, marcado) {
  let x = 46;
  const y = doc.y;
  for (const [cod, rot] of opcoes) {
    doc.lineWidth(1).rect(x, y, 10, 10).stroke('#333333');
    if (cod === marcado) doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text('X', x + 1.5, y, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor('#000000').text(rot, x + 14, y + 1, { lineBreak: false });
    x += 14 + doc.widthOfString(rot) + 18;
  }
  doc.y = y + 18;
  doc.x = 40;
}

async function gerarASOPdf(aso) {
  const doc = novoDoc(`ASO ${aso.func_nome}`);
  cabecalho(doc, 'ATESTADO DE SAÚDE OCUPACIONAL', `ASO nº ${String(aso.id).padStart(6, '0')} — NR-7`);

  secao(doc, 'Empresa');
  campos(doc, [['Razão Social', aso.razao_social], ['CNPJ', fmtCNPJ(aso.cnpj)]]);

  secao(doc, 'Trabalhador');
  campos(doc, [
    ['Nome', aso.func_nome], ['CPF', fmtCPF(aso.func_cpf)],
    ['RG', aso.func_rg], ['Data de Nascimento', fmtData(aso.func_nascimento)],
    ['Função', aso.funcao],
  ]);

  secao(doc, 'Tipo de Exame');
  caixas(doc, TIPOS_ASO, aso.tipo_codigo);

  secao(doc, 'Riscos Ocupacionais');
  blocoRiscos(doc, aso.riscos);

  secao(doc, 'Procedimentos / Exames Realizados');
  doc.font('Helvetica').fontSize(10).text(`Exame clínico em ${fmtData(aso.exame_data)}. ${aso.exames_realizados || ''}`, 46, doc.y, { width: doc.page.width - 92 });

  secao(doc, 'Conclusão');
  caixas(doc, CONCLUSOES, aso.conclusao);
  if (aso.restricoes) doc.font('Helvetica').fontSize(10).text(`Restrições: ${aso.restricoes}`, 46, doc.y, { width: doc.page.width - 92 });
  if (aso.observacoes) doc.font('Helvetica').fontSize(10).text(`Observações: ${aso.observacoes}`, 46, doc.y, { width: doc.page.width - 92 });
  doc.moveDown(0.3);
  campos(doc, [
    ['Data de Emissão', fmtData(aso.data_emissao)],
    ['Validade / Próximo Periódico', aso.data_validade ? fmtData(aso.data_validade) : 'Não se aplica'],
  ]);

  secao(doc, 'Médico Responsável');
  campos(doc, [
    ['Médico Examinador', aso.medico_nome], ['CRM', aso.medico_crm ? `${aso.medico_crm}/${aso.medico_uf_crm}` : ''],
    ['Clínica', aso.clinica_nome], ['Local', `${aso.clinica_endereco} — ${aso.clinica_cidade}/${aso.clinica_uf}`],
  ]);

  doc.moveDown(0.8);
  if (aso.hash_assinatura) {
    const url = `${APP_URL()}/#/verificar/${aso.hash_assinatura}`;
    const y = doc.y;
    const qr = await QRCode.toBuffer(url, { width: 200, margin: 1 });
    doc.rect(40, y, doc.page.width - 80, 92).stroke('#2e7d32');
    doc.image(qr, 48, y + 6, { width: 80 });
    doc.fillColor('#2e7d32').font('Helvetica-Bold').fontSize(10)
      .text('DOCUMENTO ASSINADO ELETRONICAMENTE', 138, y + 10, { width: doc.page.width - 190 });
    doc.fillColor('#000000').font('Helvetica').fontSize(8.5)
      .text(`Assinado por ${aso.medico_nome} — CRM ${aso.medico_crm}/${aso.medico_uf_crm}`, 138, doc.y + 2, { width: doc.page.width - 190 })
      .text(`Data/hora: ${aso.assinado_em}`, 138, doc.y, { width: doc.page.width - 190 })
      .font('Courier').fontSize(7).text(`Código de verificação: ${aso.hash_assinatura}`, 138, doc.y + 2, { width: doc.page.width - 190 })
      .font('Helvetica').fontSize(7.5).fillColor(CINZA).text(`Verifique em: ${url}`, 138, doc.y + 2, { width: doc.page.width - 190, link: url });
    doc.y = y + 100;
  } else {
    doc.moveDown(2);
    const meio = doc.page.width / 2;
    doc.moveTo(meio - 140, doc.y).lineTo(meio + 140, doc.y).stroke('#333333');
    doc.font('Helvetica').fontSize(9).fillColor('#000000').text('Assinatura e carimbo do médico examinador', meio - 140, doc.y + 4, { width: 280, align: 'center' });
    doc.moveDown(1.5);
    doc.moveTo(meio - 140, doc.y).lineTo(meio + 140, doc.y).stroke('#333333');
    doc.text('Assinatura do trabalhador', meio - 140, doc.y + 4, { width: 280, align: 'center' });
  }
  doc.font('Helvetica').fontSize(7).fillColor(CINZA)
    .text('Emitido em conformidade com a Norma Regulamentadora nº 7 (PCMSO). Uma via deve ser entregue ao trabalhador.', 40, doc.page.height - 60, { align: 'center', width: doc.page.width - 80 });

  return salvar(doc, `aso-${aso.id}-${aso.agendamento_codigo}.pdf`);
}

module.exports = { gerarGuia, gerarASOPdf, caminhoArquivo };
