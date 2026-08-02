# CLAUDE.md

## Propósito

Aplicação pessoal de acompanhamento de carteira de investimentos (renda fixa brasileira de balcão: CDBs % do CDI, CDBs IPCA+, LCA, LCI, debênture, Tesouro Prefixado e IPCA+). Roda self-hosted no homelab Proxmox via Coolify e é usada como PWA instalada no iPhone, acessível **apenas na rede local**.

## Stack

- **Backend**: Node 20+, ESM, Express, better-sqlite3, node-cron, dotenv
- **Frontend**: PWA vanilla JS + Chart.js via CDN em `public/index.html` (arquivo único). **Não migrar para framework sem necessidade.**
- **Dados**: API Pluggy (proxy no backend; credenciais nunca chegam ao navegador) + API SGS do Banco Central (benchmarks, pública)
- **Banco**: SQLite em `data/carteira.db` (snapshots diários da carteira e cache de benchmarks)

## Decisões

- **Credenciais só no `.env`** (`PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_ITEM_ID`). Nunca commitar `.env` (está no `.gitignore` junto com `data/` e `node_modules/`).
- **SQLite em `data/`** como volume persistente (`/app/data` no container).
- **Deploy via Coolify** apontando para o repositório, build por Dockerfile, variáveis de ambiente pela UI do Coolify, volume em `/app/data`. Healthcheck em `GET /api/health`.
- **Single-user, sem autenticação** por enquanto — o app só existe na rede local; não expor na internet.
- A apiKey da Pluggy expira em 2h; `server.js` mantém cache com renovação automática (renova aos 110 min).
- Snapshot diário automático às 08:30 America/Sao_Paulo (cron), que também atualiza o cache de benchmarks.
- Se a Pluggy estiver fora, `/api/portfolio` responde com o último snapshot salvo (`stale: true`).

## Semântica dos campos da Pluggy (`/investments`)

- `balance` — saldo **líquido** (já desconta IR provisionado)
- `amount` — valor **bruto**
- `amountOriginal` — valor aplicado
- `amountProfit` — **vem sempre null**: rendimento é calculado como `amount − amountOriginal`
- `taxes` / `taxes2` — IR provisionado
- `rate` + `rateType` (`CDI` / `IPCA` / `null`) e `fixedAnnualRate` — taxa contratada (`rateType` null = prefixado)
- `dueDate`, `issuer`, `subtype` (`CDB`, `LCA`, `LCI`, `TREASURY`, `DEBENTURES`)
- `status` — considerar apenas `ACTIVE` nos totais (`TOTAL_WITHDRAWAL` = resgatado)

## Benchmarks (SGS / Yahoo)

- SGS Banco Central (sem chave): série **12** = CDI diário (% ao dia útil), **433** = IPCA mensal (% a.m.), **11** = Selic diária. Formato: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json&dataInicial=DD/MM/AAAA`, datas em DD/MM/AAAA.
- IBOVESPA: Yahoo Finance (`query1.finance.yahoo.com/v8/finance/chart/^BVSP`), sem chave.
- Séries cacheadas na tabela `benchmarks` do SQLite; atualização incremental 1x/dia junto do snapshot. Nunca bater no SGS a cada load do frontend.

## Convenções

- **Respostas e mensagens de commit em português.**
- Frontend leve: um único `index.html` com CSS e JS inline; Chart.js via CDN.
- Cálculos de agregação/performance no backend (módulos em `lib/`); o frontend só apresenta.
- Não simular histórico passado: gráficos e comparativos usam apenas o range de snapshots existente.

## Comandos

- Rodar local: `npm install && npm start` (porta 3000, `.env` preenchido)
- Docker: `docker compose up -d --build`
