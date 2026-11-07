import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class ListQuery {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number = 20;
}

/** Query-string booleans: ?x=true / ?x=1 / ?x=false / ?x=0 (class-transformer's Boolean() would make 'false' true). */
export const ToBoolean = () => Transform(({ value }) => (value === true || value === 'true' || value === '1' ? true : value === false || value === 'false' || value === '0' ? false : value));

export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }

export const paging = (q: { page?: number; pageSize?: number }) => {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

export async function listPage<T>(q: { page?: number; pageSize?: number }, run: (skip: number, take: number) => Promise<[T[], number]>): Promise<Page<T>> {
  const { page, pageSize, skip, take } = paging(q);
  const [items, total] = await run(skip, take);
  return { items, total, page, pageSize };
}
