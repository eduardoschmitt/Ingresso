import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

export type Paged<T> = {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
};

export function paged<T>(data: T[], total: number, pagination: Pagination): Paged<T> {
  return { data, page: pagination.page, pageSize: pagination.pageSize, total };
}

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
