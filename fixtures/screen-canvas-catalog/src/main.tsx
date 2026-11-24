import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router-dom';
import './style.css';

interface Product {
  id: string;
  title: string;
  stock: number;
  tags: string[];
}

interface ProductProps {
  eyebrow: string;
}

function Catalog() {
  return <main>
    <p className="eyebrow">Field supplies</p>
    <h1>Products</h1>
    <p>Tools for a more observant walk.</p>
    <Link to="/products/field-notes">View field notes</Link>
  </main>;
}

function ProductDetails({ eyebrow }: ProductProps) {
  const { id } = useParams();
  const [product, setProduct] = useState<Product>();
  const [error, setError] = useState('');
  const [caption, setCaption] = useState(eyebrow);

  useEffect(() => {
    const update = (event: Event) => setCaption((event as CustomEvent<string>).detail);
    window.addEventListener('catalog:caption', update);
    return () => window.removeEventListener('catalog:caption', update);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/products/${id}`, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error('Product request returned ' + res.status);
        return res.json() as Promise<Product>;
      }).then(setProduct).catch(failure => {
        if (!controller.signal.aborted) setError(failure.message);
      });
    return () => controller.abort();
  }, [id]);

  if (error) return <main role="alert">{error}</main>;
  if (!product) return <main role="status">Loading product…</main>;

  return <main data-product-id={product.id}>
    <Link to="/products">Back to products</Link>
    <p className="eyebrow" data-caption>{caption}</p>
    <h1>{product.title}</h1>
    <p>In stock <strong>{product.stock}</strong></p>
    <ul>{product.tags.map((tag, index) => <li key={index}>{tag}</li>)}</ul>
  </main>;
}

function App() {
  return <BrowserRouter>
    <Routes>
      <Route path="/products" element={<Catalog />} />
      <Route path="/products/:id" element={<ProductDetails eyebrow="Field supplies" />} />
    </Routes>
  </BrowserRouter>;
}

createRoot(document.getElementById('root')!).render(<App />);
