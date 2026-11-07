'use client';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ProductForm } from '@/components/product-form';
import { ErrorBox, PageTitle, Spinner, useLoad } from '@/components/ui';

export default function EditProductPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, reload } = useLoad(() => api(`/store/products/${id}`), [id]);
  return (
    <div>
      <PageTitle title={data?.name ?? 'Product'} back="/products" sub={data?.sku ? `SKU ${data.sku}` : undefined} />
      {error ? <ErrorBox message={error} retry={reload} /> : loading && !data ? <Spinner /> : <ProductForm key={data.updatedAt} product={data} />}
    </div>
  );
}
