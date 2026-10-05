# ADR 0001 — Autoridade de inventário e concorrência em reservas

Data: 2026-10-05 · Fase 1 · Estado: aceito

## Contexto

Vários compradores disputam os mesmos assentos da mesma sessão. Qualquer
solução baseada em estado de frontend, cache ou mutex em memória está errada
por construção com múltiplos processos. A autoridade precisa ser o PostgreSQL.

## Decisão

1. **Serialização por sessão (screening).** Toda mutação de reserva abre uma
   transação `READ COMMITTED` e trava a linha da sessão com
   `SELECT … FOR UPDATE` antes de qualquer leitura/escrita de inventário.
   Concorrentes da mesma sessão serializam nessa trava; o segundo sempre
   enxerga as linhas já comitadas do primeiro.
2. **Ordem de travas fixa.** Sessão primeiro, reserva depois — em criação,
   leitura com transição, e cancelamento. Nenhum caminho adquire na ordem
   inversa (previne deadlock entre mutações).
3. **Expiração transacional, sem cron.** Cada transação reclassifica
   `HELD → EXPIRED` com o relógio do banco antes de decidir. Holds vencidos
   nunca bloqueiam inventário, mesmo sem nenhum processo de limpeza.
4. **`now()` transacional.** `now()` é o instante de início da transação,
   estável entre todos os statements. Todas as comparações de expiração e o
   cálculo de `expires_at` usam `now()` na mesma transação, logo concordam
   entre si. `clock_timestamp()`/`statement_timestamp()` são proibidos nesse
   caminho (documentado aqui para não haver "otimização" futura acidental).
5. **Idempotência sem abortar transação.** `INSERT … ON CONFLICT DO NOTHING`
   na chave única `idempotency_key`; a linha conflitante é lida na mesma
   transação e o `request_hash` (SHA-256 canônico de
   `{screeningId, seatIds ordenados}`) decide: repetição idêntica → 200 com o
   original (em qualquer estado: vale após expiração/cancelamento);
   payload divergente → 409.
6. **Consistência sala-da-poltrona no banco.** `reservation_seats` carrega
   chaves estrangeiras compostas `(assento, sala)` e `(sessão, sala)` mais
   `(reserva, sessão)`, de modo que poltrona e sessão provam pertencer à
   mesma sala — sem depender só da aplicação.
7. **Sobreposição de sessões no banco.** Exclusão GiST
   (`auditorium_id` + `tstzrange`) via SQL explícito na migration (o Drizzle
   não expressa esse constraint; snapshot permanece estável).

## Consequências e trade-offs

- **Vazão:** a trava por sessão serializa todas as reservas da mesma sessão.
  Correto para a Fase 1; é o gargalo conhecido a medir na Fase 2 e a afrouxar
  depois (ex.: travas por assento) somente com evidência.
- Leituras de mapa de assentos derivam disponibilidade ao vivo do estado
  autoritativo; cache jamais autoriza venda (regra permanente).
- `CONFIRMED` existe no modelo, sem endpoint de confirmação (Fase 4+).

## Alternativas rejeitadas

- `SERIALIZABLE` global: exigiria lógica de retry em erros de serialização
  sem ganho, dado que já serializamos explicitamente no ponto certo.
- Expiração só por job/daemon: deixa holds vencidos bloqueando inventário
  entre execuções; o sweep transacional é obrigatório, o job futuro será
  apenas higiene.
- Status espelhado em `reservation_seats` para índice parcial: risco de
  divergência entre tabelas; rejeitado em favor de trava + checagem.
