# CLAUDE.md

## Propósito

Aplicação pessoal de acompanhamento de carteira de investimentos (renda fixa brasileira de balcão: CDBs % do CDI, CDBs IPCA+, LCA, LCI, debênture, Tesouro Prefixado e IPCA+). Roda self-hosted no homelab Proxmox via Docker (stack gerenciada pelo Portainer) e é usada como PWA instalada no iPhone, acessível **apenas na rede local**.

## Stack

- **Backend**: Node 20+, ESM, Express, better-sqlite3, node-cron, dotenv
- **Frontend**: PWA vanilla JS + Chart.js via CDN em `public/index.html` (arquivo único). **Não migrar para framework sem necessidade.**
- **Dados**: API Pluggy (proxy no backend; credenciais nunca chegam ao navegador) + API SGS do Banco Central (benchmarks, pública)
- **Banco**: SQLite em `data/carteira.db` (snapshots diários da carteira e cache de benchmarks)

## Decisões

- **Credenciais só no `.env`** (`PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_ITEM_ID`). Nunca commitar `.env` (está no `.gitignore` junto com `data/` e `node_modules/`).
- **SQLite em `data/`** como volume persistente (`/app/data` no container).
- **Deploy via Docker/Portainer**: stack a partir do `docker-compose.yml` (build pelo Dockerfile), variáveis de ambiente pela UI do Portainer, dados em bind mount `./data` → `/app/data` no host. Healthcheck em `GET /api/health` (declarado no Dockerfile e no compose).
- **Atualizar o deploy exige rebuild.** O "Pull and redeploy" do Portainer faz `git pull` + `docker compose up -d`, que **não** reconstrói imagem declarada com `build:`: o container segue com o código anterior e a UI reporta sucesso. Pelo Portainer: parar a stack → remover o container → remover a imagem → "Pull and redeploy". Pelo host, no diretório da stack: `docker compose up -d --build`. Antes de qualquer uma das duas, conferir que o commit está no GitHub (`git status -sb`) — é de lá que o Portainer clona.
- **Single-user, sem autenticação** por enquanto — o app só existe na rede local; não expor na internet.
- A apiKey da Pluggy expira em 2h; `server.js` mantém cache com renovação automática (renova aos 110 min).
- O item é do conector **MeuPluggy** (id 200): proxy da conexão original, atualizado **1x/dia** pela própria Pluggy (ver `nextAutoSyncAt` do item). `PATCH /items/{id}` é recusado com 400 `"MeuPluggy item cant be updated"` — não existe sync sob demanda pela API. Não existe rota de refresh: `/api/portfolio` devolve `sync` (`lastUpdatedAt`/`nextAutoSyncAt`/`status`) e o frontend exibe isso como linha passiva no cabeçalho. Forçar atualização só pelo portal meu.pluggy.ai.
- Snapshot diário automático às 12:00 America/Sao_Paulo (cron), que também atualiza o cache de benchmarks. O horário é deliberado: fica **depois** do auto-sync do item na Pluggy (~11:13), senão o snapshot do dia guardaria a coleta do dia anterior.
- Se a Pluggy estiver fora, `/api/portfolio` responde com o último snapshot salvo (`stale: true`).

## Semântica dos campos da Pluggy (`/investments`)

- `balance` — saldo **líquido** (já desconta IR provisionado)
- `amount` — valor **bruto**
- `amountOriginal` — valor aplicado
- `amountProfit` — **vem sempre null**: rendimento é calculado como `amount − amountOriginal`
- `taxes` — IR provisionado ("income taxes"). `taxes2` é **tributo financeiro** (IOF), não IR: nunca somar os dois num total de IR. Só aparece em parte dos papéis (nos dados atuais, só nos dois Tesouros).
- `balance` desconta **taxas e tributos**, não só IR: `amount − balance` costuma ser maior que `taxes` (a diferença é custódia/taxas). Não usar `taxes` para derivar o líquido.
- `rate` + `rateType` (`CDI` / `IPCA` / `null`) e `fixedAnnualRate` — taxa contratada (`rateType` null = prefixado)
- `dueDate`, `issuer`, `subtype` (`CDB`, `LCA`, `LCI`, `TREASURY`, `DEBENTURES`)
- `status` — considerar apenas `ACTIVE` nos totais (`TOTAL_WITHDRAWAL` = resgatado)
- `quantity` / `value` — em CDB/LCA a Pluggy costuma usar quantidade = reais a R$ 1,00; só mostrar unidades quando `value` ≠ 1 (Tesouro, debênture, alguns CDBs)
- Datas (`dueDate`, `issueDate`, `tradeDate`…) são dias de calendário com hora colada: ora `T03:00Z`, ora `T00:00Z`. Formatar pela parte ISO da string — passar por `new Date().toLocaleDateString` escorrega um dia nas que vêm em `T00:00Z`.

## Detalhe do ativo

- Toque na linha da lista "Ativos" abre um painel com os números do ativo, a rentabilidade por janela (de `/api/performance`) e as movimentações.
- `GET /api/investments/:id/transactions` faz proxy de `/investments/{id}/transactions` da Pluggy, com cache na tabela `investment_txs` (TTL 12h) — a lista só muda quando há aporte ou resgate. Busca é sob demanda (só quando o painel abre); Pluggy fora devolve o cache com `stale: true`.
- Nem todo ativo tem movimentações: a Pluggy devolve lista vazia para parte dos papéis.

## Benchmarks (SGS / Yahoo)

- SGS Banco Central (sem chave): série **12** = CDI diário (% ao dia útil), **433** = IPCA mensal (% a.m.), **11** = Selic diária. Formato: `https://api.bcb.gov.br/dados/serie/bcdata.sgs.{codigo}/dados?formato=json&dataInicial=DD/MM/AAAA`, datas em DD/MM/AAAA.
- IBOVESPA: Yahoo Finance (`query1.finance.yahoo.com/v8/finance/chart/^BVSP`), sem chave.
- Séries cacheadas na tabela `benchmarks` do SQLite; atualização incremental 1x/dia junto do snapshot. Nunca bater no SGS a cada load do frontend.

## Convenções

- **Respostas e mensagens de commit em português.**
- Frontend leve: um único `index.html` com CSS e JS inline; Chart.js via CDN.
- Cálculos de agregação/performance no backend (módulos em `lib/`); o frontend só apresenta.
- Não simular histórico passado: gráficos e comparativos usam apenas o range de snapshots existente.

## Rentabilidade (spec-rentabilidade.md)

- Cálculos puros em `lib/performance.js` (TWR/Modified Dietz, benchmarks acumulados, gross up, decomposição mensal), testados em `test/performance.test.js` (`npm test`, runner nativo do Node).
- `GET /api/performance?period=ytd|3m|6m|12m|24m|max` entrega hero, séries dos gráficos, barras mensais e tabela por categoria/ativo; a resposta traz as versões com e sem gross up (toggle é client-side).
- Fluxo diário: quando o payload tem os ativos, resgate total sai pelo valor **bruto** do dia anterior (evita o artefato do Δ`total_original`, que só captura principal).

## Modo demo (dados fictícios)

- `npm run seed:demo` gera `data/demo.db` com ~14 meses de snapshots falsos (`scripts/seed-demo.js`) e busca benchmarks **reais** do SGS/Yahoo para o mesmo período. O script recusa gravar em `carteira.db`.
- `npm run demo` sobe o app com `DEMO=1 DB_PATH=data/demo.db`: não chama a Pluggy, não usa credenciais e não roda o cron. `npm start` volta ao banco real — nada a desfazer.
- Serve só para validar telas/gráficos antes de existir histórico real. **Não misturar com o banco real** e não usar como base de nenhum cálculo de verdade.

## Comandos

- Rodar local: `npm install && npm start` (porta 3000, `.env` preenchido)
- Testes: `npm test`
- Demo: `npm run seed:demo && npm run demo`
- Docker: `docker compose up -d --build`
