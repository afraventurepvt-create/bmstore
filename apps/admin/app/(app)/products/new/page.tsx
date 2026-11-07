import { ProductForm } from '@/components/product-form';
import { PageTitle } from '@/components/ui';

export default function NewProductPage() {
  return <div><PageTitle title="Add a product" back="/products" /><ProductForm /></div>;
}
