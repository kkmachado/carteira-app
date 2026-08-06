# Feature spec — Rentabilidade e evolução patrimonial (referências: Itaú e BTG)

Anexar ao prompt inicial do Claude Code (ou colar como sessão 2, após os benchmarks básicos).

## Objetivo

Replicar os dois padrões de visualização de rentabilidade dos apps do Itaú e do BTG:

1. **Rentabilidade acumulada (%) vs benchmark** (estilo Itaú "Minha carteira" / BTG "Performance")
2. **Evolução patrimonial decomposta** (estilo BTG: patrimônio, rendimentos, aportes/retiradas, impostos)

## Métricas de cabeçalho (hero do app)

- **Rendeu**: R$ e % no período selecionado (rendimento real, não variação de saldo). É o número em destaque
- **% do CDI**: rentabilidade da carteira ÷ CDI acumulado no mesmo período × 100, logo abaixo do rendimento
- **Régua de índices**: acumulado de CDI / IPCA / Selic / IBOV no mesmo período, em menor destaque e sem cor (as cores das séries ficam só nos gráficos)
- Seletor de período: No mês (padrão) / Ano / 3m / 6m / 12m / Máx (limitado ao histórico de snapshots disponível)

## Cálculo de rentabilidade — TWR (time-weighted return)

Fundamental: variação de saldo ≠ rendimento. Aportes e resgates precisam ser neutralizados.

Com os snapshots diários (tabela `snapshots`):

- **Aporte/retirada do dia** = Δ`total_original` entre snapshots consecutivos
  (aumento = aporte; redução = resgate)
- **Rendimento do dia** = Δ`total_gross` − aporte do dia
- **Retorno diário** r_t = rendimento_t / patrimônio_inicial_t (usar Modified Dietz simples no dia: denominador = gross do dia anterior + aporte do dia)
- **Rentabilidade acumulada** = ∏(1 + r_t) − 1

Validação opcional dos aportes: `GET /investments/{id}/transactions` da Pluggy (tipos BUY/SELL) — usar para reconciliar quando Δoriginal for ambíguo (ex.: resgate + aporte no mesmo dia).

## Gráfico 1 — Rentabilidade acumulada vs índices

- Eixo Y em **%**, não em R$ (padrão Itaú)
- Linhas: Carteira (TWR acumulado) + benchmark selecionável (CDI / IPCA / Selic / IBOV)
- CDI: série SGS 12 (% ao dia útil). Acumular apenas em dias úteis: fator = ∏(1 + taxa_dia/100)
- IPCA: série SGS 433 (mensal) — interpolar visualmente ou degrau mensal
- Tooltip com valores da carteira e do índice na data

## Gráfico 2 — Evolução patrimonial decomposta (estilo BTG)

- Barras mensais (agregar snapshots por mês, usar último snapshot do mês)
- Séries empilhadas/sobrepostas por mês:
  - **Patrimônio** (saldo líquido no fim do mês)
  - **Rendimentos** (soma dos rendimentos diários do mês)
  - **Aportes/Retiradas** (soma dos Δoriginal do mês; retiradas como barra negativa translúcida, como no BTG)
  - **Impostos** (Δtaxes+taxes2 do mês)
- Períodos: 3m / 6m / 12m / 24m / 36m

## Gross up (estilo Itaú)

Para comparação justa entre ativos isentos (LCA/LCI) e tributados:

- Taxa equivalente bruta do isento = rendimento ÷ (1 − alíquota IR)
- Alíquota pela tabela regressiva conforme prazo decorrido do ativo:
  22,5% (até 180d), 20% (181–360d), 17,5% (361–720d), 15% (>720d)
- Sempre aplicado (padrão Itaú), com tooltip explicando: afeta a rentabilidade exibida por ativo e o % do CDI da carteira. O toggle "sem gross up / com gross up" que existia no topo foi removido — o backend continua devolvendo as duas versões, a tela usa só a com gross up

## Tabela por categoria (estilo Itaú "Meus produtos")

- Agrupar por subtype (CDB, LCA, Tesouro, Debênture…)
- Colunas: rendimento mês atual, mês anterior, 12m, ano corrente, saldo atual
- Percentual de participação de cada categoria na carteira
- Expandir categoria → ativos individuais

## Restrições e realidade dos dados

- O histórico nasce agora: com poucos dias de snapshots, exibir os gráficos com o range disponível e um aviso discreto ("histórico desde DD/MM"). Não simular passado
- Backfill parcial possível via investment transactions (datas e valores de aportes), mas a série de patrimônio só existe do primeiro snapshot em diante
- Rentabilidade "Últ. 12m" fica disponível naturalmente após 12 meses de coleta
- Todos os cálculos no backend (novo módulo, ex.: `lib/performance.js`), com testes unitários dos casos: aporte no meio do período, resgate total de um ativo, dia sem snapshot (feriado/falha), primeiro dia da série
