# Ingresso

Plataforma fictícia de ingressos de cinema.

O projeto explora problemas reais de engenharia de software, como concorrência, consistência de dados, observabilidade e desempenho sob alta demanda. O objetivo é entender os gargalos do sistema por meio de testes e medições antes de introduzir otimizações.

## Tecnologias

- **Frontend:** Astro, React, TypeScript e Tailwind CSS.
- **Backend:** Node.js, Fastify, Drizzle ORM e Zod.
- **Banco de dados:** PostgreSQL 16.
- **Observabilidade:** Prometheus e Grafana.
- **Testes:** Vitest e k6.
- **Infraestrutura:** Docker Compose e pnpm.

## Funcionalidades

- Catálogo de filmes com páginas individuais.
- Consulta de cinemas e sessões por data.
- Mapa interativo de assentos com disponibilidade em tempo real.
- API de reservas com bloqueio temporário de assentos.
- Criação, consulta, expiração e cancelamento de reservas pela interface.
- Controle de concorrência para impedir reservas duplicadas.
- Idempotência nas operações de reserva.
- Monitoramento de requisições, latência e banco de dados.
- Testes automatizados (Vitest + Playwright) e simulações de alta demanda (k6).

## Executando localmente

**Pré-requisitos:**

- Node.js 22+
- pnpm 12.5.1
- Docker Desktop

Instale as dependências:

```bash
pnpm install
```

Copie `.env.example` para `.env` e configure `GRAFANA_ADMIN_PASSWORD`. As demais variáveis podem utilizar os valores locais predefinidos.

Inicie os serviços:

```bash
docker compose up -d
```

Prepare o banco de dados:

```bash
pnpm --filter @ingresso/api db:migrate
pnpm --filter @ingresso/api db:seed
```

Execute a aplicação:

```bash
pnpm dev
```

**Serviços locais:**

| Serviço    | Endereço              |
| ---------- | --------------------- |
| Frontend   | http://localhost:4321 |
| API        | http://localhost:3001 |
| Prometheus | http://localhost:9090 |
| Grafana    | http://localhost:3000 |

### Build do frontend

O catálogo utiliza geração estática e depende da API disponível durante o build.

```bash
pnpm --filter @ingresso/web build
pnpm --filter @ingresso/web preview
```

Alterações no catálogo ou nas rotas estáticas de sessões exigem um novo build.

### Pôsteres (TMDB, cache local opcional)

Cartazes reais vêm da API oficial do TMDB, sob os termos deles: uso
não-comercial com chave pessoal, atribuição obrigatória (logo aprovado +
aviso textual) e cache local de no máximo 6 meses. As imagens **nunca são
commitadas** (não redistribuir via git); sem elas, o fallback tipográfico
renderiza automaticamente.

```bash
# 1. Coloque sua chave pessoal em apps/web/.env (gitignored, nunca compartilhe):
# TMDB_API_KEY=...
# 2. Baixe e converta para WebP (pula o que já existe; --force renova tudo):
pnpm --filter @ingresso/web posters:sync [--force]
# 3. Remover o cache: apague apps/web/public/posters/*.webp (+ tmdb-logo.svg)
```

Sem `TMDB_API_KEY` o script recusa com erro explícito; sem o logo oficial, os
pôsteres nem são exibidos (atribuição incompleta = fallback). Detalhes em
`apps/web/scripts/sync-posters.ts`.

## Testes

Os testes de integração utilizam PostgreSQL real para validar regras de reserva, expiração, idempotência e concorrência.

```bash
pnpm test         # Vitest (API + frontend)
pnpm test:e2e     # Playwright (navegador real, banco dedicado ingresso_e2e)
```

Os testes de carga são executados com k6 em um banco isolado, permitindo observar o comportamento da API sob diferentes níveis de demanda.

As instruções estão em [`tests/load/README.md`](tests/load/README.md).

## Segurança (uso local)

Este é um projeto educacional para execução local — **não exponha a API diretamente à internet**:

- A API não possui autenticação, autorização ou rate limiting. Qualquer pessoa com um ID de reserva pode consultá-la ou cancelá-la; qualquer cliente pode segurar assentos temporariamente.
- O CORS permite apenas origens locais configuradas (`CORS_ORIGIN`); `/metrics` não tem autenticação.
- Variáveis têm padrões locais seguros; nunca commite `.env` ou segredos.

## Documentação

- [`docs/adr/`](docs/adr/) — decisões arquiteturais.
- [`docs/architecture/observability.md`](docs/architecture/observability.md) — métricas e monitoramento.
- [`docs/experiments/phase-2-baseline.md`](docs/experiments/phase-2-baseline.md) — experimentos e resultados de desempenho.

---

Projeto educacional, sem pagamentos ou venda de ingressos reais.
