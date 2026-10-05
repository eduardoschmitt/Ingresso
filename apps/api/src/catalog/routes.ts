import type { FastifyInstance } from 'fastify';

import type { Db } from '../db/client.js';
import { idParamSchema, paginationSchema } from '../http/pagination.js';
import {
  getCinema,
  getMovie,
  getScreening,
  getSeatMap,
  listCinemas,
  listMovies,
  listScreenings,
} from './service.js';

export function registerCatalogRoutes(app: FastifyInstance, deps: { db: Db }): void {
  app.get('/movies', async (request) => {
    const pagination = paginationSchema.parse(request.query);
    return listMovies(deps.db, pagination);
  });

  app.get('/movies/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return getMovie(deps.db, id);
  });

  app.get('/cinemas', async (request) => {
    const pagination = paginationSchema.parse(request.query);
    return listCinemas(deps.db, pagination);
  });

  app.get('/cinemas/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return getCinema(deps.db, id);
  });

  app.get('/screenings', async (request) => {
    const pagination = paginationSchema.parse(request.query);
    return listScreenings(deps.db, pagination);
  });

  app.get('/screenings/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return getScreening(deps.db, id);
  });

  app.get('/screenings/:id/seats', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return getSeatMap(deps.db, id);
  });
}
