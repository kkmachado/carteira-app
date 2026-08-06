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
- Coleta automática **2x/dia** às 12:00 e 19:00 America/Sao_Paulo (cron), snapshot + cache de benchmarks. 12:00 é deliberado: fica **depois** do auto-sync do item na Pluggy (~11:13), senão o snapshot guardaria a coleta do dia anterior. 19:00 existe pelos **benchmarks**, não pela carteira (o item só sincroniza 1x/dia): o SGS publica parte das séries à tarde e a B3 fecha às 17h, então o IBOV das 12:00 é cotação com pregão aberto. Serve também de segunda chance para o snapshot se a Pluggy estiver fora ao meio-dia.
- Se a Pluggy estiver fora, `/api/portfolio` responde com o último snapshot salvo (`stale: true`).
- **Snapshot é datado pela coleta da Pluggy (`item.lastUpdatedAt`), não pelo relógio** (`snapshotDateFor`). Entre a meia-noite e o auto-sync (~11:13) a carteira devolvida ainda é a de ontem: datando pelo relógio, abrir o app de madrugada criava um snapshot do dia novo com os números da véspera — ponto a mais no gráfico, dia de rendimento zero no TWR. Agora essa abertura só reescreve o snapshot da véspera. O cabeçalho mostra `dataDate` (o dia dos números), não o dia da consulta.
- Como consequência, snapshot com data **depois** da última coleta não pode ter dado próprio: `saveSnapshot` apaga essas linhas (herança da datagem por relógio). Só remove o que está à frente da coleta atual — passado não é reescrito, e as marcações manuais sobrevivem em `manual_values`.

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

## Ativos manuais / previdência

- **A Pluggy não representa previdência.** `GET /investments?type=PENSION` responde 400: `type` só aceita `MUTUAL_FUND, SECURITY, EQUITY, FIXED_INCOME, ETF, COE, OTHER`. Não é limitação do MeuPluggy — o conector Itaú nativo (id 601) também não tem produto de seguros/previdência em `products`, então trocar de item não resolve. Previdência é Open Insurance, fase que a Pluggy não cobre.
- Saída: **marcação manual**. Três tabelas: `manual_assets` (id `manual:<slug>`, nome, instituição, subtype `PENSION`/`OTHER`), `manual_values` (marcação de **saldo**: data + valor) e `manual_flows` (**aporte/resgate**: data + valor, negativo = resgate).
- **Saldo e aporte são coisas separadas.** Saldo é uma foto (muda sozinho, você só relê); aporte é um evento com data própria. O total aplicado (`amountOriginal`) **não é digitado**: é a soma dos aportes até a data. Antes o saldo e o aplicado acumulado vinham na mesma linha e a marcação mensal exigia recalcular o total na mão — fonte garantida de erro de conta, e o aporte acabava datado no dia em que alguém abriu o app, não no dia em que o dinheiro entrou. `migrateManualFlows()` converte bancos antigos (aporte de cada marcação = diferença do `original` para a marcação anterior) e derruba a coluna `original`; roda uma vez, no boot.
- Aporte sem nenhuma marcação de saldo não faz o ativo existir: sem saldo não há o que carregar. Ele passa a contar no aplicado assim que houver uma marcação posterior.
- Os manuais entram no **payload do snapshot** no formato da Pluggy, com `source: "manual"` — `/api/history`, os KPIs e a lista de ativos herdam a previdência sem contrato novo; quem precisa separar filtra pela flag.
- **Carry-forward**: numa data vale a marcação mais recente com `date ≤ ref`. Antes da primeira marcação o ativo não existe — não se extrapola passado.
- **A carteira exibida usa as marcações de HOJE** (`withManualHoje`), não as da data do snapshot. As duas regras se cruzam: o snapshot é datado pela coleta da Pluggy, que de madrugada ainda é a de ontem, enquanto o formulário propõe hoje — presa à data do snapshot, a marcação recém-feita sumia do total e da lista e o app ainda recusava recriar o ativo ("já existe"). Os snapshots seguem com `marcação ≤ data do snapshot`, então os gráficos só a incorporam no fechamento seguinte; `POST .../values` devolve `snapshots: 0` nesse caso e a tela avisa.
- Toda marcação dispara `rebuildManualInSnapshots(date)`, que reescreve a parte manual dos snapshots dali em diante (os ativos da Pluggy não são tocados). Sem isso a previdência apareceria só no dia em que foi digitada e o patrimônio daria um degrau falso.
- **Fora das séries diárias de rentabilidade** (hero, TWR, barras mensais): entre duas marcações o valor fica parado e salta de uma vez, o que viraria semanas de rendimento caindo num dia. `/api/performance` filtra `source: "manual"` dessas séries e devolve `manualExcluded` para a tela dizer isso. Continuam na tabela por categoria (janelas são intervalos, não dias, e o acumulado do intervalo está certo) e no patrimônio.
- `amount = balance` e `taxes: null`: previdência não tem IR provisionado como CDB (a tributação incide no resgate).
- Ficam **fora do card de emissores**: o alerta vermelho é o teto do FGC, que não cobre VGBL/PGBL.
- Remover é **arquivar** (`archived_at`), não apagar: o histórico já gravado nos snapshots continua de pé. Recriar com o mesmo nome **reativa** o ativo e devolve as marcações — o id vem do nome, então recusar queimaria o nome para sempre.
- Marcação parada há mais de **5 dias** (`MARCACAO_MAX_DIAS` no frontend) vira aviso âmbar no cabeçalho: o saldo só muda quando alguém digita, então um número velho estaria entrando no patrimônio como se fosse atual.
- `GET /investments/:id/transactions` recusa id manual por validação de formato; o frontend nem chama.

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
- `GET /api/performance?period=mtd|ytd|3m|6m|12m|24m|max` entrega hero, séries dos gráficos, barras mensais e tabela por categoria/ativo; a resposta traz as versões com e sem gross up, mas a tela usa **sempre** a com gross up — sem ele, LCA/LCI apareceriam com rendimento líquido ao lado de CDBs brutos e do CDI. O toggle que existia no card do topo foi removido.
- O card do topo mostra, nessa ordem: o rendimento do período em destaque, o % do CDI, e uma régua com o acumulado de CDI/IPCA/Selic/IBOV no mesmo período (calculada no frontend, do último ponto de cada série de `benchmarks` — elas já vêm recortadas pelo range). Série vazia vira `—`, não 0%: o IPCA é mensal e o mês parcial do início costuma ficar de fora.
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
