# Prompt inicial — Claude Code (colar na primeira sessão, na pasta do projeto)

Estou construindo uma aplicação pessoal de acompanhamento da minha carteira de investimentos (renda fixa brasileira), para rodar self-hosted no meu homelab Proxmox via Coolify e ser usada como PWA instalada no iPhone, acessível apenas na minha rede local.

## Estado atual

A pasta já contém um protótipo funcional que quero evoluir (não reescrever do zero):

- `server.js` — backend Node/Express (ESM) que:
  - Autentica na API da Pluggy (POST https://api.pluggy.ai/auth com clientId/clientSecret do `.env`; a apiKey expira em 2h e há cache com renovação automática)
  - Proxy `GET /api/portfolio` → `GET https://api.pluggy.ai/investments?itemId=...` (header X-API-KEY), grava snapshot diário em SQLite (better-sqlite3, `data/carteira.db`) e usa o último snapshot como fallback se a Pluggy estiver fora
  - `GET /api/history` — série de snapshots (total_balance, total_original, total_gross por dia)
  - `POST /api/refresh` — dispara `PATCH /items/{id}` na Pluggy para sincronizar com o banco
  - Cron diário 08:30 America/Sao_Paulo para snapshot automático
- `public/index.html` — frontend PWA (vanilla JS + Chart.js via CDN), manifest e ícones para "Adicionar à Tela de Início" no iOS
- `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`

Minha carteira é 100% renda fixa de balcão (CDBs % do CDI, CDBs IPCA+, LCAs, LCI, debênture, Tesouro Prefixado e IPCA+). Os campos relevantes do JSON da Pluggy: `balance` (líquido, já desconta IR provisionado), `amount` (bruto), `amountOriginal` (aplicado), `taxes`/`taxes2`, `rate`, `rateType` (CDI/IPCA/null), `fixedAnnualRate`, `dueDate`, `issuer`, `subtype` (CDB, LCA, LCI, TREASURY, DEBENTURES), `status` (ACTIVE / TOTAL_WITHDRAWAL). Atenção: `amountProfit` vem null — rendimento é calculado como `amount - amountOriginal`.

## O que quero nesta primeira sessão

1. **Crie um CLAUDE.md** na raiz documentando: propósito do projeto, stack, decisões (credenciais só no `.env`, SQLite em `data/` como volume persistente, deploy via Coolify apontando pro repo com build por Dockerfile), e convenções (respostas e commits em português).
2. **Rode o projeto localmente** (`npm install && npm start`, `.env` já preenchido por mim) e valide o fluxo real contra a Pluggy.
3. **Benchmarks brasileiros** — feature principal desta sessão:
   - Novo endpoint `GET /api/benchmarks` consumindo a API SGS do Banco Central (pública, sem chave): `https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json&dataInicial=DD/MM/AAAA`
   - Séries: **12** (CDI diário), **433** (IPCA mensal), **11** (Selic diária, opcional)
   - IBOVESPA via brapi.dev ou Yahoo Finance (`^BVSP`)
   - Cachear as séries no SQLite (tabela própria) para não bater no SGS a cada load; atualizar 1x/dia junto do snapshot
   - No gráfico de evolução do frontend, adicionar a linha "100% do CDI": simular o valor aplicado (`total_original`) rendendo o CDI acumulado desde o primeiro snapshot, para comparar com o saldo real
   - Card comparativo no dashboard: rentabilidade da carteira vs CDI vs IPCA no período disponível
4. **Ajustes de robustez**: tratamento de erro visível no frontend, loading states, e um `GET /api/health` simples para o healthcheck do Coolify.

## Restrições

- Uso pessoal, single-user, sem autenticação por enquanto (rede local apenas; não expor na internet)
- Nunca commitar `.env`; garantir `.gitignore` com `.env`, `data/`, `node_modules/`
- Manter o frontend leve (vanilla JS + Chart.js está ótimo; não migrar para framework sem necessidade)
- Deploy alvo: Coolify no Proxmox, build por Dockerfile, variáveis de ambiente pela UI do Coolify, volume em `/app/data`

Comece pelo item 1 (CLAUDE.md), me mostre o plano dos itens 3 e 4 antes de implementar, e vamos por etapas.
