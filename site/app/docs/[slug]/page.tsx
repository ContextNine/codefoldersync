import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocArticle } from "../doc-article";
import { docs, findDoc } from "../docs";

interface DocRouteProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return docs.filter((doc) => doc.slug).map((doc) => ({ slug: doc.slug }));
}

export async function generateMetadata({
  params,
}: DocRouteProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) return {};
  return {
    title: doc.title,
    description: doc.description,
    openGraph: {
      title: doc.title,
      description: doc.description,
      images: [],
    },
    twitter: {
      title: doc.title,
      description: doc.description,
      images: [],
    },
  };
}

export default async function DocumentationPage({ params }: DocRouteProps) {
  const { slug } = await params;
  const doc = findDoc(slug);
  if (!doc) notFound();
  return <DocArticle doc={doc} />;
}
