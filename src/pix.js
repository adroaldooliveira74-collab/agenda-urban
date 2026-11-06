'use strict';
/**
 * Geração do payload PIX "copia e cola" (BR Code / EMV-QRCPS-MPM),
 * conforme o Manual de Padrões para Iniciação do Pix do Banco Central.
 */

function tlv(id, valor) {
  const v = String(valor);
  return id + String(v.length).padStart(2, '0') + v;
}

/** CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF). */
function crc16(str) {
  let crc = 0xffff;
  const bytes = Buffer.from(str, 'utf8');
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Remove acentos e caracteres fora do conjunto aceito pelo BR Code. */
function limpa(s, max) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .\-@/]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * @param {object} p
 * @param {string} p.chave   Chave PIX (CPF/CNPJ, e-mail, telefone +55..., ou aleatória)
 * @param {string} p.nome    Nome do recebedor (até 25)
 * @param {string} p.cidade  Cidade do recebedor (até 15)
 * @param {number} [p.valor] Valor em reais
 * @param {string} [p.txid]  Identificador (até 25, alfanumérico)
 * @param {string} [p.descricao] Informação adicional
 */
function gerarPayloadPix({ chave, nome, cidade, valor, txid, descricao }) {
  if (!chave) throw new Error('Chave PIX não configurada');
  const gui = tlv('00', 'br.gov.bcb.pix');
  let conta = gui + tlv('01', String(chave).trim());
  const desc = limpa(descricao, 40);
  if (desc && conta.length + 4 + desc.length <= 99) conta += tlv('02', desc);

  const txidLimpo = String(txid || '***').replace(/[^A-Za-z0-9*]/g, '').slice(0, 25) || '***';

  let payload =
    tlv('00', '01') +
    tlv('26', conta) +
    tlv('52', '0000') +
    tlv('53', '986') +
    (valor ? tlv('54', Number(valor).toFixed(2)) : '') +
    tlv('58', 'BR') +
    tlv('59', limpa(nome, 25) || 'RECEBEDOR') +
    tlv('60', limpa(cidade, 15) || 'BRASIL') +
    tlv('62', tlv('05', txidLimpo));

  payload += '6304';
  return payload + crc16(payload);
}

module.exports = { gerarPayloadPix, crc16 };
