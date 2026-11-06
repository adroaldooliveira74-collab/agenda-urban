<p align="center"><img src="public/img/logo.png" alt="UrbanClin — Medicina e Segurança do Trabalho" width="260"></p>

# UrbanClin — Agenda de Exames Ocupacionais (NR-7 / PCMSO)

Plataforma web para gestão de exames ocupacionais conforme a **NR-7 (PCMSO)**. A empresa solicita e agenda o exame online, recebe a guia de encaminhamento em PDF com **PIX (QR Code + copia e cola)**, e acompanha tudo até a emissão do **ASO assinado eletronicamente**.

## Como rodar

Requisito: **Node.js 22.13 ou superior** (usa o SQLite embutido do Node, sem banco externo).

```bash
npm install
npm start
```

Acesse <http://localhost:3000>. No primeiro início o banco é criado em `data/` com dados de demonstração.

| Perfil | Login | Senha |
|---|---|---|
| Administrador | e-mail da consultoria (`ADMIN_EMAIL`, padrão urban.ambiental@hotmail.com) | senha inicial |
| Empresa | **CNPJ ou CPF** da empresa (com ou sem pontuação) | senha inicial |
| Clínica (demonstração) | clinica@urbanclin.com.br | clinica123 |
| Médico (demonstração) | medico@urbanclin.com.br | medico123 |

**Senha inicial:** `urban1234` (variável `SENHA_INICIAL`). No primeiro acesso o sistema obriga a criar uma senha nova; até lá, nada além da troca de senha fica liberado.

**Acesso das empresas:**
- Toda empresa cadastrada (pela administração ou no agendamento) ganha login pelo CNPJ, ou pelo CPF quando o empregador é pessoa física.
- Empresa cliente da consultoria no **eSocial Brasil** que ainda não está no sistema: no primeiro login com o CNPJ/CPF e a senha inicial, os dados dela são trazidos do eSocial e o acesso é criado.
- **Sincronização diária às 00:00** (`ESOCIAL_SYNC_HORA`, horário de Brasília via `TZ=America/Sao_Paulo`): o sistema lê a lista de empresas do eSocial Brasil e grava **só as novas ou alteradas** (cada empresa guarda uma impressão digital dos dados; se nada mudou, nada é gravado). Empresa nova já ganha o acesso. **Só entram empresas liberadas**: bloqueada no eSocial não é cadastrada nem consegue criar acesso; se ficar bloqueada depois, sai do sistema (ou, se já tiver agendamentos/funcionários aqui, fica inativa e sem acesso) e volta quando for liberada. Se o servidor estiver parado à meia-noite, roda assim que voltar. Em *Empresas* aparece a última sincronização e o botão *Sincronizar agora*.
- Empresa liberada sem CNPJ/CPF válido no eSocial, ou segunda empresa do mesmo dono (mesmo CPF), entra também e ganha um **código de acesso** `ES` + número do eSocial (ex.: `ES23178`), que aparece na coluna *Acesso* e serve de login com a senha inicial.
- Em *Empresas*, a coluna *Acesso* mostra se a empresa já criou a senha, e o botão *Redefinir senha* volta o acesso para a senha inicial.

> Em produção: defina `SEED_DEMO=false`, troque `JWT_SECRET` e, se quiser, `SENHA_INICIAL`.

Testes automatizados: `npm test`.

## Publicar na nuvem (Render)

[![Deploy no Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/adroaldooliveira74-collab/agenda-urban)

O arquivo `render.yaml` já configura tudo (Node 22, `npm ci`, `npm start`, verificação em `/healthz` e `JWT_SECRET` gerado automaticamente). Clique no botão, entre com a sua conta do GitHub e confirme em **Apply**. Cada `git push` na `main` publica uma nova versão.

> **Plano gratuito = só para testes:** o serviço "dorme" após 15 minutos sem acesso (o primeiro acesso depois disso demora cerca de 30 s) e o disco é temporário, então banco, PDFs e comprovantes voltam aos dados de demonstração a cada reinício. Para uso real, use um plano pago com disco persistente montado em `/var/data` e a variável `DATA_DIR=/var/data`.

## Configuração (`.env`)

Copie `.env.example` para `.env`. Principais variáveis:

- `APP_URL`: endereço público (vai nos PDFs e no link de verificação do ASO).
- `JWT_SECRET`: chave da sessão.
- **E-mail:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
- **WhatsApp:** `WHATSAPP_API_URL` e `WHATSAPP_API_TOKEN`. O sistema faz `POST` com JSON `{ phone, message, fileName?, fileBase64? }`, o que serve para Z-API, Evolution API, WPPConnect etc. (ajuste o formato em `src/notify.js` se o provedor pedir outro).

- **eSocial Brasil:** `ESOCIAL_TOKEN` (chave da API de integração). No Render, cadastre em *Environment*; na máquina local, se vazio, o sistema usa `~/.esocial/credenciais.env`.

Sem SMTP/WhatsApp configurados, cada envio fica registrado como **simulado** em *Envios e alertas*, e o restante do sistema funciona normalmente.

## Funcionalidades

**Perfis de acesso**
- **Administrador:** empresas, clínicas, médicos, usuários, tipos de exame, valores por clínica, PIX, faturamento, relatórios (CSV), log de envios e dashboard completo.
- **Clínica:** agenda diária, confirmação de comparecimento e de pagamento, resultados, laudos, emissão de ASO, reagendamento.
- **Empresa:** solicitação e agendamento, histórico, documentos, download do ASO, vencimentos.
- **Médico:** agenda, atendimento, observações, emissão e **assinatura eletrônica** do ASO.

**Fluxo de solicitação**
1. Dados da empresa (CNPJ, razão social, responsável, telefone, e-mail) e do funcionário (nome, RG, CPF, telefone, nascimento, função), com validação de CPF/CNPJ.
2. Tipo de exame NR-7: Admissional, Demissional, Periódico, Mudança de Função ou Retorno ao Trabalho. O sistema **identifica o tipo automaticamente** pelo histórico (sem cadastro → admissional; afastado → retorno; função diferente → mudança de função; demais → periódico) e mostra os avisos da NR-7.
3. Clínicas disponíveis com endereço, valor e Google Maps; datas e horários livres conforme expediente, intervalo e capacidade de cada clínica.
4. Confirmação: gera a **Guia de Encaminhamento em PDF** com dados da empresa, do funcionário, do exame e da clínica, valor, chave PIX, QR Code PIX e o **aviso obrigatório em vermelho**. A guia é enviada por e-mail e WhatsApp para a empresa, o funcionário e a clínica.

**Pagamento:** Aguardando Pagamento → Comprovante Enviado → Pagamento Confirmado / Recusado. O atendimento e o ASO são bloqueados até o pagamento ser confirmado.

**ASO e histórico (PCMSO):** o ASO registra riscos, exames, conclusão (apto / apto com restrição / inapto) e validade. A emissão atualiza o histórico do funcionário (admissão, periódicos, mudanças de função, retornos, demissão). A assinatura eletrônica grava um hash SHA-256 com o médico, o CRM e a data/hora, e o PDF traz um QR Code para a verificação pública em `/#/verificar/<código>`.

> A assinatura é eletrônica simples (Lei 14.063/2020). Para assinatura qualificada com certificado ICP-Brasil, é preciso integrar um provedor de certificado digital.

**Riscos ocupacionais por função (PGR):** em *Empresas → Riscos por função*, cadastre os riscos físicos, químicos, biológicos, ergonômicos e de acidentes de cada função. Ao agendar, a guia e o ASO já saem com os riscos da função; **função sem cadastro sai com os riscos em branco**. Com o eSocial Brasil configurado, a empresa é localizada pelo CNPJ, a função registrada lá para o CPF também é considerada, e o botão *Trazer funções do eSocial Brasil* cria a lista de funções da empresa para você preencher os riscos.

**Dashboards:** administrativo (exames de hoje, pendentes, cancelamentos, receita do dia/mês/ano, gráficos de agendamentos, exames por empresa, faturamento e comparecimento), da clínica e da empresa (solicitados, pendentes, ASOs, vencimentos próximos, funcionários em atraso).

**Alertas automáticos** (a cada `ALERTAS_INTERVALO_MIN` minutos, por e-mail e WhatsApp):
- vencimento de exames 90, 60, 30 e 15 dias antes;
- lembrete de agendamento 72 h, 24 h e 2 h antes.

Cada alerta é enviado uma única vez. Agendamentos não atendidos em dias anteriores passam a "ausente".

## Estrutura

```
src/
  server.js      servidor Express
  db.js          esquema SQLite
  seed.js        dados iniciais / demonstração
  services.js    regras de negócio (agenda, NR-7, ASO, vencimentos)
  pix.js         PIX BR Code (padrão Banco Central, CRC16)
  pdf.js         guia de encaminhamento e ASO em PDF
  notify.js      e-mail e WhatsApp
  scheduler.js   alertas automáticos
  routes/api.js  rotas de empresa, clínica, médico e documentos
  routes/admin.js rotas administrativas
public/          interface web (HTML/CSS/JS, sem build)
test/            testes (node --test)
```
