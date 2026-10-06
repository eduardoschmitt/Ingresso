import 'dotenv/config';

import { pathToFileURL } from 'node:url';

import type { Db } from './client.js';
import { createDb, createPool } from './client.js';
import { auditoriums, cinemas, movies, screenings, seats } from './schema.js';
import { loadEnv } from '../env.js';
import { assertLocalDatabaseUrl } from './guards.js';

// Deterministic, idempotent seed (Phase 1).
// - Fixed dataset: same input on every run, no randomness, no external APIs.
// - Natural-key upserts (`onConflictDoNothing`) make re-runs a no-op.
// - Years and durations are established theatrical records; pt-BR titles only
//   where standard in Brazil; `posterUrl` stays NULL (no unverified refs,
//   no copyrighted downloads).
// - Screening times are fixed UTC fixtures; tests build their own data.

type MovieSeed = typeof movies.$inferInsert;

const MOVIES: MovieSeed[] = [
  {
    title: 'X-Men',
    titlePtBr: 'X-Men',
    releaseYear: 2000,
    durationMinutes: 104,
    genre: 'Ação',
    synopsis: 'Mutantes divididos entre coexistência e confronto recrutam novos aliados.',
  },
  {
    title: 'Gladiator',
    titlePtBr: 'Gladiador',
    releaseYear: 2000,
    durationMinutes: 155,
    genre: 'Ação',
    synopsis: 'Um general romano traído luta como gladiador em busca de justiça.',
  },
  {
    title: 'The Lord of the Rings: The Fellowship of the Ring',
    titlePtBr: 'O Senhor dos Anéis: A Sociedade do Anel',
    releaseYear: 2001,
    durationMinutes: 178,
    genre: 'Fantasia',
    synopsis: 'Um hobbit e oito companheiros partem para destruir um anel maligno.',
  },
  {
    title: 'Spider-Man',
    titlePtBr: 'Homem-Aranha',
    releaseYear: 2002,
    durationMinutes: 121,
    genre: 'Ação',
    synopsis: 'Um estudante picado por uma aranha assume a defesa de Nova York.',
  },
  {
    title: 'Catch Me If You Can',
    titlePtBr: 'Prenda-me Se For Capaz',
    releaseYear: 2002,
    durationMinutes: 141,
    genre: 'Crime',
    synopsis: 'Um jovem falsificador é perseguido por um agente do FBI.',
  },
  {
    title: 'Cidade de Deus',
    titlePtBr: 'Cidade de Deus',
    releaseYear: 2002,
    durationMinutes: 130,
    genre: 'Crime',
    synopsis: 'Dois jovens seguem rumos opostos em uma favela do Rio de Janeiro.',
  },
  {
    title: 'The Lord of the Rings: The Two Towers',
    titlePtBr: 'O Senhor dos Anéis: As Duas Torres',
    releaseYear: 2002,
    durationMinutes: 179,
    genre: 'Fantasia',
    synopsis: 'A sociedade se divide enquanto a guerra pela Terra-média avança.',
  },
  {
    title: 'The Lord of the Rings: The Return of the King',
    titlePtBr: 'O Senhor dos Anéis: O Retorno do Rei',
    releaseYear: 2003,
    durationMinutes: 201,
    genre: 'Fantasia',
    synopsis: 'O confronto final decide o destino do anel e dos reinos livres.',
  },
  {
    title: 'Pirates of the Caribbean: The Curse of the Black Pearl',
    titlePtBr: 'Piratas do Caribe: A Maldição do Pérola Negra',
    releaseYear: 2003,
    durationMinutes: 143,
    genre: 'Aventura',
    synopsis: 'Um pirata excêntrico e um ferreiro caçam um navio amaldiçoado.',
  },
  {
    title: 'Finding Nemo',
    titlePtBr: 'Procurando Nemo',
    releaseYear: 2003,
    durationMinutes: 100,
    genre: 'Animação',
    synopsis: 'Um peixe-palhaço cruza o oceano para resgatar o filho.',
  },
  {
    title: 'Batman Begins',
    titlePtBr: 'Batman Begins',
    releaseYear: 2005,
    durationMinutes: 140,
    genre: 'Ação',
    synopsis: 'Bruce Wayne forja-se como vigilante para salvar Gotham City.',
  },
  {
    title: 'The Departed',
    titlePtBr: 'Os Infiltrados',
    releaseYear: 2006,
    durationMinutes: 151,
    genre: 'Crime',
    synopsis: 'Um policial infiltrado e um criminoso infiltrado caçam um ao outro.',
  },
  {
    title: 'Transformers',
    titlePtBr: 'Transformers',
    releaseYear: 2007,
    durationMinutes: 144,
    genre: 'Ação',
    synopsis: 'Robôs alienígenas rivais disputam um artefato na Terra.',
  },
  {
    title: 'Ratatouille',
    titlePtBr: 'Ratatouille',
    releaseYear: 2007,
    durationMinutes: 111,
    genre: 'Animação',
    synopsis: 'Um rato cozinheiro persegue o sonho em um restaurante de Paris.',
  },
  {
    title: 'Iron Man',
    titlePtBr: 'Homem de Ferro',
    releaseYear: 2008,
    durationMinutes: 126,
    genre: 'Ação',
    synopsis: 'Um industrial constrói uma armadura e assume a identidade de herói.',
  },
  {
    title: 'The Dark Knight',
    titlePtBr: 'Batman: O Cavaleiro das Trevas',
    releaseYear: 2008,
    durationMinutes: 152,
    genre: 'Ação',
    synopsis: 'Batman enfrenta o caos imposto pelo Coringa em Gotham City.',
  },
  {
    title: 'WALL-E',
    titlePtBr: 'WALL·E',
    releaseYear: 2008,
    durationMinutes: 98,
    genre: 'Animação',
    synopsis: 'Um robô compactador encontra um novo propósito além da Terra.',
  },
  {
    title: 'Up',
    titlePtBr: 'Up: Altas Aventuras',
    releaseYear: 2009,
    durationMinutes: 96,
    genre: 'Animação',
    synopsis: 'Um viúvo realiza a viagem dos sonhos em uma casa voadora.',
  },
  {
    title: 'Inception',
    titlePtBr: 'A Origem',
    releaseYear: 2010,
    durationMinutes: 148,
    genre: 'Ficção',
    synopsis: 'Um ladrão de segredos tenta plantar uma ideia em um sonho.',
  },
];

const CINEMAS = [
  { name: 'Cine Ingresso Paulista', location: 'São Paulo, SP' },
  { name: 'Cine Ingresso Centro', location: 'Rio de Janeiro, RJ' },
] as const;

// [cinemaName, roomName, rows, seatsPerRow]
const AUDITORIUMS = [
  ['Cine Ingresso Paulista', 'Sala 1', 10, 12],
  ['Cine Ingresso Paulista', 'Sala 2', 8, 10],
  ['Cine Ingresso Centro', 'Sala 1', 6, 8],
] as const;

// [movieTitle, releaseYear, cinemaName, roomName, startsAtUtc, durationMin, priceCents]
// End times include a 30-minute turnover buffer after the feature.
const SCREENINGS = [
  [
    'The Dark Knight',
    2008,
    'Cine Ingresso Paulista',
    'Sala 1',
    '2026-12-18T21:00:00.000Z',
    152,
    3200,
  ],
  ['Ratatouille', 2007, 'Cine Ingresso Paulista', 'Sala 1', '2026-12-19T15:00:00.000Z', 111, 2400],
  ['Inception', 2010, 'Cine Ingresso Paulista', 'Sala 1', '2026-12-19T21:00:00.000Z', 148, 3200],
  ['Iron Man', 2008, 'Cine Ingresso Paulista', 'Sala 2', '2026-12-18T20:00:00.000Z', 126, 3200],
  [
    'Cidade de Deus',
    2002,
    'Cine Ingresso Paulista',
    'Sala 2',
    '2026-12-19T20:00:00.000Z',
    130,
    3200,
  ],
  ['WALL-E', 2008, 'Cine Ingresso Centro', 'Sala 1', '2026-12-19T16:00:00.000Z', 98, 2400],
  ['The Departed', 2006, 'Cine Ingresso Centro', 'Sala 1', '2026-12-19T20:30:00.000Z', 151, 3200],
] as const;

function rowLabel(index: number): string {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

export type SeedCounts = {
  movies: number;
  cinemas: number;
  auditoriums: number;
  seats: number;
  screenings: number;
};

// Runs the full seed against any database handle. Idempotent: re-runs only
// top up missing rows keyed by natural unique constraints.
export async function runSeed(db: Db): Promise<SeedCounts> {
  await db
    .insert(movies)
    .values([...MOVIES])
    .onConflictDoNothing({
      target: [movies.title, movies.releaseYear],
    });
  const movieRows = await db.select().from(movies);
  const movieId = new Map(movieRows.map((m) => [`${m.title}|${m.releaseYear}`, m.id]));

  await db
    .insert(cinemas)
    .values([...CINEMAS])
    .onConflictDoNothing({
      target: cinemas.name,
    });
  const cinemaRows = await db.select().from(cinemas);
  const cinemaId = new Map(cinemaRows.map((c) => [c.name, c.id]));

  await db
    .insert(auditoriums)
    .values(
      AUDITORIUMS.map(([cinemaName, name, rows, seatsPerRow]) => ({
        cinemaId: cinemaId.get(cinemaName) ?? -1,
        name,
        capacity: rows * seatsPerRow,
      })),
    )
    .onConflictDoNothing({ target: [auditoriums.cinemaId, auditoriums.name] });
  const auditoriumRows = await db.select().from(auditoriums);
  const auditoriumKey = new Map(
    auditoriumRows.map((a) => [`${a.cinemaId}|${a.name}`, { id: a.id, capacity: a.capacity }]),
  );

  const seatValues = AUDITORIUMS.flatMap(([cinemaName, roomName, rows, seatsPerRow]) => {
    const room = auditoriumKey.get(`${cinemaId.get(cinemaName)}|${roomName}`);
    if (room === undefined) throw new Error(`seed: missing auditorium ${cinemaName}/${roomName}`);
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: seatsPerRow }, (_, n) => ({
        auditoriumId: room.id,
        rowLabel: rowLabel(r),
        seatNumber: n + 1,
      })),
    ).flat();
  });
  await db
    .insert(seats)
    .values(seatValues)
    .onConflictDoNothing({
      target: [seats.auditoriumId, seats.rowLabel, seats.seatNumber],
    });

  const screeningValues = SCREENINGS.map(
    ([title, releaseYear, cinemaName, roomName, startsAt, durationMin, priceCents]) => {
      const id = movieId.get(`${title}|${releaseYear}`);
      const room = auditoriumKey.get(`${cinemaId.get(cinemaName)}|${roomName}`);
      if (id === undefined || room === undefined) {
        throw new Error(`seed: missing ref ${title} @ ${cinemaName}/${roomName}`);
      }
      const starts = new Date(startsAt);
      return {
        movieId: id,
        auditoriumId: room.id,
        startsAt: starts,
        endsAt: new Date(starts.getTime() + (durationMin + 30) * 60_000),
        priceCents,
      };
    },
  );
  await db
    .insert(screenings)
    .values(screeningValues)
    .onConflictDoNothing({
      target: [screenings.auditoriumId, screenings.startsAt],
    });

  const counts = {
    movies: (await db.select().from(movies)).length,
    cinemas: (await db.select().from(cinemas)).length,
    auditoriums: (await db.select().from(auditoriums)).length,
    seats: (await db.select().from(seats)).length,
    screenings: (await db.select().from(screenings)).length,
  };
  console.log(`seed-ok ${JSON.stringify(counts)}`);
  return counts;
}

const invokedAsCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsCli) {
  const { DATABASE_URL } = loadEnv();
  assertLocalDatabaseUrl(DATABASE_URL, 'db:seed');
  const pool = createPool(DATABASE_URL);
  try {
    await runSeed(createDb(pool));
  } finally {
    await pool.end();
  }
}
