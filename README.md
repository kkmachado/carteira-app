# Carteira — acompanhamento de investimentos (Pluggy)

App pessoal para rodar no homelab, acessível só na rede local.
Backend Node (Express) faz proxy da API da Pluggy (credenciais nunca vão ao
navegador), grava snapshot diário em SQLite (histórico de evolução) e serve
o frontend PWA.

## Subir com Docker (LXC/VM no Proxmox ou Easypanel)

1. Copie a pasta para o servidor
2. `cp .env.example .env` e preencha clientId, clientSecret e itemId
3. `docker compose up -d --build`
4. Acesse http://IP_DO_SERVIDOR:3000

## Sem Docker

Node 20+: `npm install && npm start`

## Instalar como app no iPhone

Abra a URL no Safari → botão Compartilhar → "Adicionar à Tela de Início".
O manifest faz o app abrir em tela cheia (standalone), sem barra do Safari.

## Endpoints

- `GET /api/portfolio` — carteira atual (grava snapshot do dia; usa cache SQLite como fallback se a Pluggy estiver fora)
- `GET /api/history` — série de snapshots para o gráfico de evolução
- `GET /api/performance?period=ytd|3m|6m|12m|24m|max` — rentabilidade (TWR), benchmarks e tabela por categoria/ativo
- `GET /api/investments/:id/transactions` — movimentações do ativo (proxy da Pluggy, cache de 12h no SQLite)
- `GET /api/benchmarks?from=YYYY-MM-DD` — séries CDI/IPCA/Selic (SGS Bacen) e IBOV (Yahoo), cacheadas no SQLite e atualizadas 1x/dia
- `GET /api/health` — healthcheck (usado pelo Docker; não chama a Pluggy)

Não existe rota de sync sob demanda: o item é do conector MeuPluggy, que a Pluggy
atualiza sozinha 1x/dia e recusa `PATCH /items/{id}`. O frescor dos dados vem em
`sync` no `/api/portfolio`; forçar atualização, só pelo portal meu.pluggy.ai.

Snapshot automático diário às 12:00 (America/Sao_Paulo), depois do auto-sync da Pluggy.
O banco fica em `./data/carteira.db` (volume persistente).

## Observações

- A apiKey da Pluggy expira em 2h; o backend renova sozinho.
- Sem HTTPS o service worker não roda, mas o app instalado funciona
  normalmente (só sem cache offline). Se quiser, coloque atrás do seu
  reverse proxy com certificado local.
