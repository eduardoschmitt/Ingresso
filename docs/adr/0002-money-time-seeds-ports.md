# ADR 0002 — Dinheiro, tempo, seeds e portas

Data: 2026-10-05 · Fase 1 · Estado: aceito

## Dinheiro em centavos inteiros

`screenings.price_cents` é `integer CHECK >= 0`. Sem `numeric`/`float` em
caminho de cobrança: aritmética exata, sem erro de arredondamento binário. A
API expõe `priceCents` explicitamente (unidades mínimas), nunca "reais com
ponto flutuante".

## Tempo em UTC, relógio do banco decide

Todas as colunas temporais são `timestamptz`. Expiração de holds compara
`expires_at <= now()` **no PostgreSQL**, nunca com relógio da aplicação
(evita skew entre instâncias). O `created_at` padrão é `now()` do banco.

## Seeds determinísticos e idempotentes

- Dataset fixo (19 filmes 2000–2010, 2 cinemas, 3 salas, 248 assentos,
  7 sessões); sem aleatoriedade, sem APIs externas.
- Anos/durações de catálogo amplamente documentado; títulos pt-BR só quando
  consagrados; `poster_url` sempre NULL (sem refs não verificadas, sem
  downloads com copyright).
- Idempotência por `ON CONFLICT DO NOTHING` em chaves naturais; segunda
  execução é no-op (verificado: contagens idênticas).
- `capacity` da sala é redundante com `count(seats)` por exigência do modelo;
  teste automatizado (`seeds.test.ts`) afirma a igualdade em vez de confiar.

## Porta do Postgres configurável

O Compose publica `${DB_PORT:-5432}:5432`. Padrão continua 5432 (convencional);
máquinas com PostgreSQL nativo definem `DB_PORT` no `.env` local (gitignored)
e sincronizam `DATABASE_URL`/`TEST_DATABASE_URL`. Sem IPs de container
hardcoded, sem portas específicas de máquina no repo.

## Banco de teste isolado e verificado

Testes de integração exigem banco dedicado cujo nome termina em `_test`
(`TEST_DATABASE_URL`, padrão `…/ingresso_test`). O harness: cria o banco se
ausente, aplica migrations via `migrator`, e — antes de cada `TRUNCATE` —
reconfirma `current_database()` na conexão viva. Qualquer divergência aborta
em vez de truncar o banco errado.
